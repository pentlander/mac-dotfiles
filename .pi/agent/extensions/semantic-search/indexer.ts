/**
 * Incremental indexing: file walking, hashing, and update orchestration.
 *
 * Walks a directory tree, hashes files with xxhash, compares against
 * the database, and only re-embeds changed files.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { resolve, extname, relative, join } from "node:path";
import xxhashInit from "xxhash-wasm";
import ignore from "ignore";
import { SearchDB } from "./db.js";
import { Embedder } from "./embedder.js";
import { extractChunks, isSupportedFile, type ChunkInfo } from "./chunker.js";

/** Directories to always skip. */
const SKIP_DIRS = new Set([
  "node_modules",
  "vendor",
  "__pycache__",
  "target",
  "build",
  "dist",
  ".git",
  ".jj",
  ".code-search-cache",
  ".next",
  ".nuxt",
]);

/** File patterns to skip (generated code, etc.) */
const SKIP_PATTERNS = [
  /\.pb\.go$/,
  /\.pb\.gw\.go$/,
  /_generated\.go$/,
  /\.gen\.go$/,
  /\.d\.ts$/,
  /\.min\.js$/,
  /\.bundle\.js$/,
];

/** Config file extensions — only index top-level blocks, not leaf keys */
const CONFIG_EXTENSIONS = new Set([
  ".toml",
  ".yaml",
  ".yml",
  ".hcl",
  ".tf",
  ".tfvars",
]);

export interface IndexStats {
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number;
  filesDeleted: number;
  symbolsIndexed: number;
  indexTimeMs: number;
  embedTimeMs: number;
}

let xxhash: Awaited<ReturnType<typeof xxhashInit>> | null = null;

async function getXxhash() {
  if (!xxhash) {
    xxhash = await xxhashInit();
  }
  return xxhash;
}

/**
 * Incrementally index a directory scope.
 *
 * @param scanDir  Absolute path to the directory to scan for files
 * @param repoRoot Absolute path to the repo root (paths stored relative to this)
 * @param db       SearchDB instance (DB lives at repoRoot/.code-search-cache/)
 * @param embedder Initialized Embedder instance
 * @param signal   AbortSignal for cancellation
 * @param onProgress Progress callback
 * @returns Index statistics
 */
export async function indexDirectory(
  scanDir: string,
  repoRoot: string,
  db: SearchDB,
  embedder: Embedder,
  signal?: AbortSignal,
  onProgress?: (msg: string) => void,
): Promise<IndexStats> {
  const start = performance.now();
  const hash = await getXxhash();

  const stats: IndexStats = {
    filesScanned: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    filesDeleted: 0,
    symbolsIndexed: 0,
    indexTimeMs: 0,
    embedTimeMs: 0,
  };

  // Load .gitignore files from repoRoot down to scanDir
  const ignoreFactory = typeof ignore === "function" ? ignore : ignore.default;
  const ig = ignoreFactory();

  const rootGitignore = join(repoRoot, ".gitignore");
  if (existsSync(rootGitignore)) {
    ig.add(readFileSync(rootGitignore, "utf-8"));
  }
  if (scanDir !== repoRoot) {
    const rel = relative(repoRoot, scanDir);
    const parts = rel.split("/");
    let cur = repoRoot;
    for (const part of parts) {
      cur = join(cur, part);
      const gi = join(cur, ".gitignore");
      if (cur !== repoRoot && existsSync(gi)) {
        ig.add(readFileSync(gi, "utf-8"));
      }
    }
  }

  // Collect all supported files under scanDir, paths relative to repoRoot
  onProgress?.("Scanning files...");
  const files = collectFiles(scanDir, ig, repoRoot);
  stats.filesScanned = files.length;

  if (signal?.aborted) return stats;

  // Scope prefix for filtering existing DB entries
  const scopePrefix = scanDir === repoRoot
    ? null
    : relative(repoRoot, scanDir);

  // Get existing indexed files — only those within our scan scope
  const existingFiles = new Map<string, string>();
  for (const f of db.getAllFiles()) {
    if (scopePrefix === null || f.path.startsWith(scopePrefix + "/")) {
      existingFiles.set(f.path, f.hash);
    }
  }

  // Determine what needs updating
  const toIndex: Array<{ absPath: string; relPath: string; fileHash: string }> = [];
  const seen = new Set<string>();

  for (const absPath of files) {
    const relPath = relative(repoRoot, absPath);
    seen.add(relPath);

    const content = readFileSync(absPath, "utf-8");
    const fileHash = hash.h64ToString(content);

    const existingHash = existingFiles.get(relPath);
    if (existingHash === fileHash) {
      stats.filesSkipped++;
      continue;
    }

    toIndex.push({ absPath, relPath, fileHash });
  }

  // Find deleted files (only within our scan scope)
  const toDelete: string[] = [];
  for (const [path] of existingFiles) {
    if (!seen.has(path)) {
      toDelete.push(path);
    }
  }

  if (toIndex.length === 0 && toDelete.length === 0) {
    stats.indexTimeMs = Math.round(performance.now() - start);
    return stats;
  }

  const parts: string[] = [];
  if (toIndex.length > 0) parts.push(`${toIndex.length} changed`);
  if (toDelete.length > 0) parts.push(`${toDelete.length} deleted`);
  onProgress?.(`Updating index: ${parts.join(", ")}...`);

  // Process in a transaction
  db.transaction(() => {
    // Delete removed files
    for (const path of toDelete) {
      db.deleteFileAndSymbols(path);
      stats.filesDeleted++;
    }
  });

  // Extract chunks from files that need indexing
  const allChunks: Array<{ chunks: ChunkInfo[]; relPath: string; fileHash: string; language: string }> = [];

  for (const { absPath, relPath, fileHash } of toIndex) {
    if (signal?.aborted) break;

    try {
      const chunks = await extractChunks(absPath, repoRoot);
      const lang = chunks.length > 0 ? chunks[0].language : "unknown";
      allChunks.push({ chunks, relPath, fileHash, language: lang });
    } catch {
      // Skip files that fail to parse
      stats.filesSkipped++;
    }
  }

  if (signal?.aborted) return stats;

  // Collect all embedding texts
  const allTexts: string[] = [];
  const chunkMap: Array<{ batchIdx: number; chunk: ChunkInfo; relPath: string; fileHash: string; language: string }> = [];

  for (const { chunks, relPath, fileHash, language } of allChunks) {
    for (const chunk of chunks) {
      chunkMap.push({ batchIdx: allTexts.length, chunk, relPath, fileHash, language });
      allTexts.push(chunk.embeddingText);
    }
  }

  if (allTexts.length === 0) {
    // Files changed but produced no symbols (e.g. empty files)
    db.transaction(() => {
      for (const { relPath, fileHash, language } of allChunks) {
        db.deleteFileAndSymbols(relPath);
        db.upsertFile(relPath, fileHash, language, 0);
      }
    });
    stats.filesIndexed = allChunks.length;
    stats.indexTimeMs = Math.round(performance.now() - start);
    return stats;
  }

  // Embed all texts
  const embedStart = performance.now();
  onProgress?.(`Embedding ${allTexts.length} symbols...`);
  const embeddings = await embedder.embed(allTexts, false, signal);
  stats.embedTimeMs = Math.round(performance.now() - embedStart);

  if (signal?.aborted || embeddings.length < allTexts.length) return stats;

  // Write to database
  onProgress?.("Writing to index...");

  db.transaction(() => {
    // Delete old symbols for changed files
    const deletedPaths = new Set<string>();
    for (const { relPath } of allChunks) {
      if (!deletedPaths.has(relPath)) {
        db.deleteFileAndSymbols(relPath);
        deletedPaths.add(relPath);
      }
    }

    // Insert new symbols
    for (const { batchIdx, chunk } of chunkMap) {
      db.insertSymbol(
        embeddings[batchIdx],
        chunk.language,
        chunk.kind,
        chunk.filePath,
        chunk.name,
        chunk.line,
        chunk.endLine,
        chunk.signature,
        chunk.embeddingText,
      );
      stats.symbolsIndexed++;
    }

    // Update file records
    const fileSymbolCounts = new Map<string, number>();
    for (const { chunk } of chunkMap) {
      const count = fileSymbolCounts.get(chunk.filePath) ?? 0;
      fileSymbolCounts.set(chunk.filePath, count + 1);
    }

    for (const { relPath, fileHash, language } of allChunks) {
      const count = fileSymbolCounts.get(relPath) ?? 0;
      db.upsertFile(relPath, fileHash, language, count);
      stats.filesIndexed++;
    }
  });

  stats.indexTimeMs = Math.round(performance.now() - start);
  return stats;
}

/**
 * Collect all supported files in a directory, respecting .gitignore and skip patterns.
 */
function collectFiles(
  dir: string,
  ig: any,
  rootDir: string,
): string[] {
  const found: string[] = [];

  function walk(d: string) {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = resolve(d, entry.name);
      const relPath = relative(rootDir, fullPath);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (ig.ignores(relPath + "/")) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        if (ig.ignores(relPath)) continue;
        if (!isSupportedFile(entry.name)) continue;
        if (SKIP_PATTERNS.some((p) => p.test(entry.name))) continue;
        found.push(fullPath);
      }
    }
  }

  walk(dir);
  return found;
}
