/**
 * Native backend: wraps the Rust napi addon for GPU embedding + SQLite.
 *
 * All embedding and vector search happens in Rust on Metal GPU.
 * Embeddings never cross the FFI boundary.
 */

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ChunkInfo } from "./chunker.js";

// ── Types matching the Rust napi exports ───────────────────────────────

interface NativeAddon {
  init(modelDir: string, tokenizerPath: string): void;
  openDb(dbPath: string): void;
  closeDb(): void;
  indexSymbols(
    symbols: Array<{
      embeddingText: string;
      filePath: string;
      name: string;
      kind: string;
      language: string;
      line: number;
      endLine?: number | null;
      signature?: string | null;
    }>,
  ): void;
  search(
    queries: string[],
    topK: number,
    threshold: number,
    filters: {
      language?: string | null;
      kind?: string | null;
      pathPrefix?: string | null;
    },
  ): Array<{
    filePath: string;
    name: string;
    kind: string;
    language: string;
    line: number;
    endLine?: number | null;
    signature?: string | null;
    score: number;
  }>;
  deleteFiles(paths: string[]): void;
  upsertFiles(
    files: Array<{
      path: string;
      hash: string;
      language?: string | null;
      symbolCount: number;
    }>,
  ): void;
  dbGetAllFiles(): Array<{
    path: string;
    hash: string;
    language?: string | null;
    symbolCount?: number | null;
    indexedAt: number;
  }>;
  dbGetStats(): { symbolCount: number; fileCount: number };
}

export interface SearchResult {
  file_path: string;
  name: string;
  kind: string;
  language: string;
  line: number;
  end_line: number | null;
  signature: string | null;
  score: number;
}

export interface FileRow {
  path: string;
  hash: string;
  language: string | null;
  symbol_count: number | null;
  indexed_at: number;
}

// ── Paths ──────────────────────────────────────────────────────────────

const CACHE_BASE = join(homedir(), ".cache", "semantic-search", "models");
const SAFETENSORS_DIR = join(CACHE_BASE, "CodeRankEmbed-safetensors");
const ONNX_DIR = join(CACHE_BASE, "CodeRankEmbed-onnx-q8");
const TOKENIZER_PATH = join(ONNX_DIR, "tokenizer.json");
const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const ADDON_PATH = join(__dir, "native", "semantic-search-native.node");

// ── Backend class ──────────────────────────────────────────────────────

export class NativeBackend {
  private native: NativeAddon;
  private currentDbPath: string | null = null;

  constructor() {
    if (!existsSync(ADDON_PATH)) {
      throw new Error(`Native addon not found at ${ADDON_PATH}. Run 'cargo build --release' in native/`);
    }
    if (!existsSync(join(SAFETENSORS_DIR, "model.safetensors"))) {
      throw new Error(`Model not found at ${SAFETENSORS_DIR}/model.safetensors`);
    }
    if (!existsSync(TOKENIZER_PATH)) {
      throw new Error(`Tokenizer not found at ${TOKENIZER_PATH}`);
    }

    this.native = require(ADDON_PATH) as NativeAddon;
    this.native.init(SAFETENSORS_DIR, TOKENIZER_PATH);
  }

  openDb(dbPath: string): void {
    if (this.currentDbPath === dbPath) return;
    if (this.currentDbPath) {
      try { this.native.closeDb(); } catch { /* ignore */ }
    }
    this.native.openDb(dbPath);
    this.currentDbPath = dbPath;
  }

  closeDb(): void {
    if (this.currentDbPath) {
      try { this.native.closeDb(); } catch { /* ignore */ }
      this.currentDbPath = null;
    }
  }

  getAllFiles(): FileRow[] {
    return this.native.dbGetAllFiles().map((r) => ({
      path: r.path,
      hash: r.hash,
      language: r.language ?? null,
      symbol_count: r.symbolCount ?? null,
      indexed_at: r.indexedAt,
    }));
  }

  deleteFiles(paths: string[]): void {
    if (paths.length > 0) this.native.deleteFiles(paths);
  }

  upsertFiles(files: Array<{ path: string; hash: string; language: string | null; symbolCount: number }>): void {
    if (files.length === 0) return;
    // napi-rs doesn't accept null for Option<String> — omit instead
    this.native.upsertFiles(files.map((f) => {
      const r: { path: string; hash: string; language?: string; symbolCount: number } = {
        path: f.path, hash: f.hash, symbolCount: f.symbolCount,
      };
      if (f.language) r.language = f.language;
      return r;
    }));
  }

  indexSymbols(chunks: ChunkInfo[]): void {
    if (chunks.length === 0) return;
    // napi-rs doesn't accept null for Option<T> — omit instead
    this.native.indexSymbols(
      chunks.map((c) => {
        const s: any = {
          embeddingText: c.embeddingText,
          filePath: c.filePath,
          name: c.name,
          kind: c.kind,
          language: c.language,
          line: c.line,
        };
        if (c.endLine != null) s.endLine = c.endLine;
        if (c.signature != null) s.signature = c.signature;
        return s;
      }),
    );
  }

  search(
    queries: string[],
    topK: number,
    threshold: number,
    language?: string,
    kind?: string,
    pathPrefix?: string,
  ): SearchResult[] {
    const filters: { language?: string; kind?: string; pathPrefix?: string } = {};
    if (language) filters.language = language;
    if (kind) filters.kind = kind;
    if (pathPrefix) filters.pathPrefix = pathPrefix;
    return this.native.search(queries, topK, threshold, filters).map((r) => ({
      file_path: r.filePath,
      name: r.name,
      kind: r.kind,
      language: r.language,
      line: r.line,
      end_line: r.endLine ?? null,
      signature: r.signature ?? null,
      score: r.score,
    }));
  }

  getStats(): { symbolCount: number; fileCount: number } {
    return this.native.dbGetStats();
  }

  dispose(): void {
    this.closeDb();
  }
}
