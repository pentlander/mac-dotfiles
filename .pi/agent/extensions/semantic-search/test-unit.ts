/**
 * Unit tests for individual components.
 *
 * Run with: npx tsx test-unit.ts
 */
import { SearchDB } from "./db.js";
import { Embedder } from "./embedder.js";
import { extractChunks } from "./chunker.js";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";

const TEST_DIR = "/tmp/semantic-search-test";
const DB_PATH = join(TEST_DIR, ".code-search-cache", "index.db");

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

async function main() {
  // Clean up
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });

  // 1. DB + sqlite-vec
  console.log("\n1. DB + sqlite-vec");
  {
    const db = new SearchDB(DB_PATH);
    const stats = db.getStats();
    assert(stats.symbolCount === 0, "Empty DB has 0 symbols");
    assert(stats.fileCount === 0, "Empty DB has 0 files");

    // Insert a file record
    db.upsertFile("test.go", "abc123", "go", 5);
    const file = db.getFile("test.go");
    assert(file !== undefined, "File record exists after insert");
    assert(file?.hash === "abc123", "File hash matches");

    // Insert a symbol with a fake embedding
    const fakeEmb = new Float32Array(768);
    fakeEmb[0] = 1.0; // unit vector in first dimension
    db.insertSymbol(fakeEmb, "go", "function", "test.go", "TestFunc", 10, 20, "func TestFunc()", "go | test.go | func TestFunc()");

    const stats2 = db.getStats();
    assert(stats2.symbolCount === 1, "1 symbol after insert");

    // KNN search with the same vector
    const results = db.search(fakeEmb, 5);
    assert(results.length === 1, "KNN returns 1 result");
    assert(results[0].name === "TestFunc", "KNN result name matches");
    assert(results[0].score > 0.99, `KNN score ~1.0 for identical vector (got ${results[0].score.toFixed(4)})`);

    // Path prefix filtering (post-filter with over-fetch)
    const embA = new Float32Array(768); embA[0] = 0.9; embA[1] = 0.1;
    const embB = new Float32Array(768); embB[0] = 0.8; embB[2] = 0.2;
    db.insertSymbol(embA, "go", "function", "pkg/a/foo.go", "Foo", 1, 10, "func Foo()", "go | pkg/a/foo.go | func Foo()");
    db.insertSymbol(embB, "go", "function", "pkg/b/bar.go", "Bar", 1, 10, "func Bar()", "go | pkg/b/bar.go | func Bar()");

    const allResults = db.search(fakeEmb, 10);
    assert(allResults.length === 3, `No prefix: 3 results (got ${allResults.length})`);

    const scopedResults = db.search(fakeEmb, 10, undefined, undefined, "pkg/a");
    assert(scopedResults.length === 1, `Prefix pkg/a: 1 result (got ${scopedResults.length})`);
    assert(scopedResults[0].name === "Foo", `Prefix pkg/a returns Foo (got ${scopedResults[0].name})`);

    const scopedB = db.search(fakeEmb, 10, undefined, undefined, "pkg/b");
    assert(scopedB.length === 1, `Prefix pkg/b: 1 result (got ${scopedB.length})`);

    const noMatch = db.search(fakeEmb, 10, undefined, undefined, "other");
    assert(noMatch.length === 0, `Prefix other: 0 results (got ${noMatch.length})`);

    // Delete
    db.deleteFileAndSymbols("test.go");
    db.deleteFileAndSymbols("pkg/a/foo.go");
    db.deleteFileAndSymbols("pkg/b/bar.go");
    const stats3 = db.getStats();
    assert(stats3.symbolCount === 0, "0 symbols after delete");

    db.close();
  }

  // 2. Chunker
  console.log("\n2. Chunker (tree-sitter)");
  {
    const testFile = process.env.SEARCH_TEST_FILE;
    const testRoot = process.env.SEARCH_TEST_TARGET;
    if (!testFile || !testRoot) {
      console.log("  ⊘ Skipped (set SEARCH_TEST_FILE and SEARCH_TEST_TARGET env vars)");
    } else {
      const relPath = testFile.startsWith(testRoot) ? testFile.slice(testRoot.length + 1) : testFile;
      const chunks = await extractChunks(testFile, testRoot);
      assert(chunks.length > 0, `Extracted ${chunks.length} chunks from ${relPath}`);
      assert(chunks[0].embeddingText.includes(" | "), "Embedding text contains separator");
      assert(chunks[0].filePath === relPath, `File path is relative (${chunks[0].filePath})`);
      assert(chunks[0].line > 0, "Line number is positive");
    }
  }

  // 3. Embedder
  console.log("\n3. Embedder");
  {
    const embedder = new Embedder();
    assert(embedder.isModelDownloaded(), "Model is already downloaded");

    await embedder.init();

    const texts = [
      "go | controller/limits.go | func NewRateLimiter(cfg Config) *RateLimiter",
      "go | middleware/abuse.go | func AbuseMiddleware(limiter *RateLimiter) Middleware",
    ];
    const embeddings = await embedder.embed(texts);
    assert(embeddings.length === 2, "Got 2 embeddings");
    assert(embeddings[0].length === 768, "Embedding dimension is 768");

    // Check L2 normalization
    let norm = 0;
    for (let i = 0; i < 768; i++) norm += embeddings[0][i] * embeddings[0][i];
    norm = Math.sqrt(norm);
    assert(Math.abs(norm - 1.0) < 0.01, `Embedding is L2-normalized (norm=${norm.toFixed(4)})`);

    // Query embedding
    const queryEmb = await embedder.embedQuery("rate limiting");
    assert(queryEmb.length === 768, "Query embedding dimension is 768");

    // Similarity: "rate limiting" should be more similar to "RateLimiter" than "AbuseMiddleware"
    function dot(a: Float32Array, b: Float32Array): number {
      let s = 0;
      for (let i = 0; i < a.length; i++) s += a[i] * b[i];
      return s;
    }
    const sim0 = dot(queryEmb, embeddings[0]);
    const sim1 = dot(queryEmb, embeddings[1]);
    assert(sim0 > sim1, `"rate limiting" closer to RateLimiter (${sim0.toFixed(3)}) than AbuseMiddleware (${sim1.toFixed(3)})`);

    await embedder.dispose();
  }

  // Cleanup
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch(console.error);
