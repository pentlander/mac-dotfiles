/**
 * SQLite + sqlite-vec database layer.
 *
 * Uses a regular table for symbols with BLOB embeddings, and sqlite-vec's
 * vec_distance_l2() scalar function for brute-force KNN search.
 * L2 distance on L2-normalized vectors gives identical ranking to cosine.
 *
 * This approach (vs vec0 virtual table) allows arbitrary SQL WHERE clauses
 * for filtering by path prefix, language, kind, etc.
 */

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA_VERSION = 3;
const DIMENSIONS = 768;

export interface FileRow {
  path: string;
  hash: string;
  language: string | null;
  symbol_count: number | null;
  indexed_at: number;
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

export class SearchDB {
  private db: DatabaseType;

  // Prepared statements
  private stmtInsertFile: DatabaseType.Statement;
  private stmtDeleteFile: DatabaseType.Statement;
  private stmtGetFile: DatabaseType.Statement;
  private stmtGetAllFiles: DatabaseType.Statement;
  private stmtInsertSymbol: DatabaseType.Statement;
  private stmtDeleteSymbolsByFile: DatabaseType.Statement;
  private stmtSymbolCount: DatabaseType.Statement;
  private stmtFileCount: DatabaseType.Statement;

  /** Cache for dynamically-built search queries */
  private searchCache = new Map<string, DatabaseType.Statement>();

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    sqliteVec.load(this.db);

    this.db.pragma("journal_mode = WAL");

    this.initSchema();

    // Prepare statements
    this.stmtInsertFile = this.db.prepare(
      `INSERT OR REPLACE INTO files (path, hash, language, symbol_count, indexed_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    this.stmtDeleteFile = this.db.prepare(`DELETE FROM files WHERE path = ?`);
    this.stmtGetFile = this.db.prepare(`SELECT * FROM files WHERE path = ?`);
    this.stmtGetAllFiles = this.db.prepare(`SELECT * FROM files`);

    this.stmtInsertSymbol = this.db.prepare(
      `INSERT INTO symbols (embedding, file_path, name, kind, language, line, end_line, signature, embedding_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.stmtDeleteSymbolsByFile = this.db.prepare(
      `DELETE FROM symbols WHERE file_path = ?`
    );

    this.stmtSymbolCount = this.db.prepare(`SELECT count(*) as count FROM symbols`);
    this.stmtFileCount = this.db.prepare(`SELECT count(*) as count FROM files`);
  }

  private initSchema(): void {
    const hasMetaTable = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='meta'`)
      .get();

    if (hasMetaTable) {
      const versionRow = this.db
        .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
        .get() as { value: string } | undefined;

      if (versionRow && parseInt(versionRow.value) === SCHEMA_VERSION) {
        return;
      }

      // Version mismatch — drop and recreate
      this.db.exec(`DROP TABLE IF EXISTS files`);
      this.db.exec(`DROP TABLE IF EXISTS symbols`);
      this.db.exec(`DROP TABLE IF EXISTS vec_symbols`);
      this.db.exec(`DROP TABLE IF EXISTS meta`);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        language TEXT,
        symbol_count INTEGER,
        indexed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY,
        embedding BLOB NOT NULL,
        file_path TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        language TEXT NOT NULL,
        line INTEGER NOT NULL,
        end_line INTEGER,
        signature TEXT,
        embedding_text TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path);
      CREATE INDEX IF NOT EXISTS idx_symbols_language ON symbols(language);
      CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
    `);

    this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(
      "schema_version", String(SCHEMA_VERSION)
    );
    this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(
      "model", "CodeRankEmbed-onnx-q8"
    );
    this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(
      "dimensions", String(DIMENSIONS)
    );
  }

  getFile(path: string): FileRow | undefined {
    return this.stmtGetFile.get(path) as FileRow | undefined;
  }

  getAllFiles(): FileRow[] {
    return this.stmtGetAllFiles.all() as FileRow[];
  }

  upsertFile(path: string, hash: string, language: string | null, symbolCount: number): void {
    this.stmtInsertFile.run(path, hash, language, symbolCount, Date.now());
  }

  deleteFileAndSymbols(filePath: string): void {
    this.stmtDeleteSymbolsByFile.run(filePath);
    this.stmtDeleteFile.run(filePath);
  }

  insertSymbol(
    embedding: Float32Array,
    language: string,
    kind: string,
    filePath: string,
    name: string,
    line: number,
    endLine: number | null,
    signature: string | null,
    embeddingText: string,
  ): void {
    this.stmtInsertSymbol.run(
      Buffer.from(embedding.buffer),
      filePath,
      name,
      kind,
      language,
      line,
      endLine,
      signature,
      embeddingText,
    );
  }

  /**
   * Search for similar symbols using brute-force L2 distance.
   * L2 on L2-normalized vectors gives identical ranking to cosine similarity.
   * Score = 1 - (L2² / 2), which maps L2 distance back to cosine similarity [0,1].
   */
  search(
    queryEmbedding: Float32Array,
    topK: number,
    language?: string,
    kind?: string,
    pathPrefix?: string,
  ): SearchResult[] {
    const whereClauses: string[] = [];
    const params: any[] = [Buffer.from(queryEmbedding.buffer)];
    let cacheKey = "";

    if (pathPrefix) {
      whereClauses.push("file_path LIKE ?");
      params.push(pathPrefix + "/%");
      cacheKey += "p";
    }
    if (language) {
      whereClauses.push("language = ?");
      params.push(language);
      cacheKey += "l";
    }
    if (kind) {
      whereClauses.push("kind = ?");
      params.push(kind);
      cacheKey += "k";
    }

    params.push(topK);

    let stmt = this.searchCache.get(cacheKey);
    if (!stmt) {
      const where = whereClauses.length > 0
        ? "WHERE " + whereClauses.join(" AND ")
        : "";
      // For L2-normalized vectors: cosine_similarity = 1 - L2²/2
      const sql = `
        SELECT file_path, name, kind, language, line, end_line, signature,
               vec_distance_l2(embedding, ?) as _dist
        FROM symbols
        ${where}
        ORDER BY _dist ASC
        LIMIT ?
      `;
      stmt = this.db.prepare(sql);
      this.searchCache.set(cacheKey, stmt);
    }

    const rows = stmt.all(...params) as (SearchResult & { _dist: number })[];
    // Convert L2 distance to cosine similarity score
    return rows.map((r) => {
      const { _dist, ...rest } = r;
      return { ...rest, score: 1 - (_dist * _dist) / 2 };
    });
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  getStats(): { symbolCount: number; fileCount: number } {
    const symbols = this.stmtSymbolCount.get() as { count: number };
    const files = this.stmtFileCount.get() as { count: number };
    return { symbolCount: symbols.count, fileCount: files.count };
  }

  close(): void {
    this.db.close();
  }
}
