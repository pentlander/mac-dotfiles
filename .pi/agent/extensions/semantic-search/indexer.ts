/**
 * Incremental indexing: file walking, hashing, and update orchestration.
 *
 * Walks a directory tree, hashes files with xxhash, compares against
 * the database, and only re-embeds changed files.
 *
 * Uses the native Rust backend — embed+store is a single FFI call.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import xxhashInit from "xxhash-wasm";
import ignore from "ignore";
import type { NativeBackend } from "./native-backend.js";
import { extractChunks, isSupportedFile, type ChunkInfo } from "./chunker.js";

const SKIP_DIRS = new Set([
  "node_modules", "vendor", "__pycache__", "target", "build", "dist",
  ".git", ".jj", ".code-search-cache", ".next", ".nuxt",
]);

const SKIP_PATTERNS = [
  /\.pb\.go$/, /\.pb\.gw\.go$/, /_generated\.go$/, /\.gen\.go$/,
  /\.d\.ts$/, /\.min\.js$/, /\.bundle\.js$/,
];

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
  if (!xxhash) xxhash = await xxhashInit();
  return xxhash;
}

/**
 * Incrementally index a directory scope.
 */
export async function indexDirectory(
  scanDir: string,
  repoRoot: string,
  backend: NativeBackend,
  signal?: AbortSignal,
  onProgress?: (msg: string) => void,
): Promise<IndexStats> {
  const start = performance.now();
  const hash = await getXxhash();

  const stats: IndexStats = {
    filesScanned: 0, filesIndexed: 0, filesSkipped: 0,
    filesDeleted: 0, symbolsIndexed: 0, indexTimeMs: 0, embedTimeMs: 0,
  };

  // Load .gitignore chain
  const ignoreFactory = typeof ignore === "function" ? ignore : ignore.default;
  const ig = ignoreFactory();

  const rootGitignore = join(repoRoot, ".gitignore");
  if (existsSync(rootGitignore)) ig.add(readFileSync(rootGitignore, "utf-8"));
  if (scanDir !== repoRoot) {
    const rel = relative(repoRoot, scanDir);
    let cur = repoRoot;
    for (const part of rel.split("/")) {
      cur = join(cur, part);
      const gi = join(cur, ".gitignore");
      if (cur !== repoRoot && existsSync(gi)) ig.add(readFileSync(gi, "utf-8"));
    }
  }

  // Collect files
  onProgress?.("Scanning files...");
  const files = collectFiles(scanDir, ig, repoRoot);
  stats.filesScanned = files.length;
  if (signal?.aborted) return stats;

  // Scope prefix
  const scopePrefix = scanDir === repoRoot ? null : relative(repoRoot, scanDir);

  // Get existing indexed files within scope
  const existingFiles = new Map<string, string>();
  for (const f of backend.getAllFiles()) {
    if (scopePrefix === null || f.path.startsWith(scopePrefix + "/")) {
      existingFiles.set(f.path, f.hash);
    }
  }

  // Diff: what changed, what's new
  const toIndex: Array<{ absPath: string; relPath: string; fileHash: string }> = [];
  const seen = new Set<string>();

  for (const absPath of files) {
    const relPath = relative(repoRoot, absPath);
    seen.add(relPath);
    const content = readFileSync(absPath, "utf-8");
    const fileHash = hash.h64ToString(content);
    if (existingFiles.get(relPath) === fileHash) {
      stats.filesSkipped++;
      continue;
    }
    toIndex.push({ absPath, relPath, fileHash });
  }

  // Deleted files
  const toDelete: string[] = [];
  for (const [path] of existingFiles) {
    if (!seen.has(path)) toDelete.push(path);
  }

  if (toIndex.length === 0 && toDelete.length === 0) {
    stats.indexTimeMs = Math.round(performance.now() - start);
    return stats;
  }

  const parts: string[] = [];
  if (toIndex.length > 0) parts.push(`${toIndex.length} changed`);
  if (toDelete.length > 0) parts.push(`${toDelete.length} deleted`);
  onProgress?.(`Updating index: ${parts.join(", ")}...`);

  // 1. Delete removed files (1 FFI call)
  if (toDelete.length > 0) {
    backend.deleteFiles(toDelete);
    stats.filesDeleted = toDelete.length;
  }

  // 2. Extract chunks via tree-sitter (TypeScript)
  const allFileChunks: Array<{
    chunks: ChunkInfo[]; relPath: string; fileHash: string; language: string;
  }> = [];

  for (const { absPath, relPath, fileHash } of toIndex) {
    if (signal?.aborted) break;
    try {
      const chunks = await extractChunks(absPath, repoRoot);
      const lang = chunks.length > 0 ? chunks[0].language : "unknown";
      allFileChunks.push({ chunks, relPath, fileHash, language: lang });
    } catch {
      stats.filesSkipped++;
    }
  }

  if (signal?.aborted) return stats;

  const allChunks: ChunkInfo[] = allFileChunks.flatMap((f) => f.chunks);

  // 3. Delete old symbols for changed files (1 FFI call)
  backend.deleteFiles(allFileChunks.map((f) => f.relPath));

  // 4. Embed + store all chunks (1 FFI call — the big one)
  if (allChunks.length > 0) {
    onProgress?.(`Embedding ${allChunks.length} symbols...`);
    const embedStart = performance.now();
    backend.indexSymbols(allChunks);
    stats.embedTimeMs = Math.round(performance.now() - embedStart);
    stats.symbolsIndexed = allChunks.length;
  }

  if (signal?.aborted) return stats;

  // 5. Update file records (1 FFI call)
  const fileSymbolCounts = new Map<string, number>();
  for (const c of allChunks) {
    fileSymbolCounts.set(c.filePath, (fileSymbolCounts.get(c.filePath) ?? 0) + 1);
  }

  backend.upsertFiles(
    allFileChunks.map((f) => ({
      path: f.relPath,
      hash: f.fileHash,
      language: f.language,
      symbolCount: fileSymbolCounts.get(f.relPath) ?? 0,
    })),
  );

  stats.filesIndexed = allFileChunks.length;
  stats.indexTimeMs = Math.round(performance.now() - start);
  return stats;
}

function collectFiles(dir: string, ig: any, rootDir: string): string[] {
  const found: string[] = [];

  function walk(d: string) {
    let entries: ReturnType<typeof readdirSync>;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
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
