/**
 * End-to-end test: cold start → index → search → incremental → search
 *
 * Run with: npx tsx test-e2e.ts
 */
import { SearchDB } from "./db.js";
import { Embedder } from "./embedder.js";
import { indexDirectory } from "./indexer.js";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";

const REPO_ROOT = process.env.SEARCH_TEST_REPO;
const TARGET = process.env.SEARCH_TEST_TARGET;
if (!REPO_ROOT || !TARGET) {
  console.error("Set SEARCH_TEST_REPO and SEARCH_TEST_TARGET env vars, e.g.:");
  console.error("  SEARCH_TEST_REPO=~/myrepo SEARCH_TEST_TARGET=~/myrepo/pkg npx tsx test-e2e.ts");
  process.exit(1);
}
const CACHE = join(REPO_ROOT, ".code-search-cache");

async function main() {
  // Clean slate
  if (existsSync(CACHE)) rmSync(CACHE, { recursive: true, force: true });

  const embedder = new Embedder();
  await embedder.init();

  // Cold start index
  console.log("=== Cold Start ===");
  const db = new SearchDB(join(CACHE, "index.db"));
  const stats1 = await indexDirectory(TARGET, REPO_ROOT, db, embedder, undefined, (msg) => console.log(`  ${msg}`));
  console.log(`  ${stats1.symbolsIndexed} symbols, ${stats1.filesIndexed} files, ${stats1.indexTimeMs}ms total (${stats1.embedTimeMs}ms embed)\n`);

  // Search (scoped to packages/tcp-proxy)
  for (const query of ["rate limiting", "TLS certificate", "connection pooling", "health check endpoint"]) {
    const qEmb = await embedder.embedQuery(query);
    const results = db.search(qEmb, 3, undefined, undefined, "packages/tcp-proxy");
    console.log(`"${query}":`);
    for (const r of results) {
      console.log(`  ${r.score.toFixed(3)} ${r.file_path}:${r.line} ${r.name}`);
    }
  }

  // Incremental (no changes)
  console.log("\n=== Incremental (no changes) ===");
  const stats2 = await indexDirectory(TARGET, REPO_ROOT, db, embedder);
  console.log(`  ${stats2.filesScanned} scanned, ${stats2.filesSkipped} skipped, ${stats2.filesIndexed} indexed, ${stats2.indexTimeMs}ms\n`);

  // Filtered search
  console.log("=== Filtered search (kind=struct) ===");
  const qEmb = await embedder.embedQuery("network configuration");
  const results = db.search(qEmb, 5, undefined, "struct", "packages/tcp-proxy");
  for (const r of results) {
    console.log(`  ${r.score.toFixed(3)} ${r.file_path}:${r.line} [${r.kind}] ${r.name}`);
  }

  // Stats
  const dbStats = db.getStats();
  console.log(`\nIndex: ${dbStats.symbolCount} symbols, ${dbStats.fileCount} files`);

  // Cleanup
  db.close();
  await embedder.dispose();
  rmSync(CACHE, { recursive: true, force: true });
  console.log("\n✓ All tests passed");
}

main().catch(console.error);
