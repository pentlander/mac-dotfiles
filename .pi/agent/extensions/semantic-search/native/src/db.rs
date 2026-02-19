//! SQLite + sqlite-vec database layer.
//!
//! Same schema as the TypeScript db.ts (schema version 3).
//! Uses vec_distance_l2() for brute-force KNN search on L2-normalized vectors.

use rusqlite::{params, Connection, Result as SqlResult};
use std::path::Path;

const SCHEMA_VERSION: i32 = 3;

#[derive(Debug, Clone)]
pub struct FileRow {
    pub path: String,
    pub hash: String,
    pub language: Option<String>,
    pub symbol_count: Option<i32>,
    pub indexed_at: i64,
}

#[derive(Debug, Clone)]
pub struct SearchResult {
    pub file_path: String,
    pub name: String,
    pub kind: String,
    pub language: String,
    pub line: i32,
    pub end_line: Option<i32>,
    pub signature: Option<String>,
    pub score: f64,
}

#[derive(Debug, Clone)]
pub struct Stats {
    pub symbol_count: i64,
    pub file_count: i64,
}

pub struct SearchDB {
    conn: Connection,
}

impl SearchDB {
    pub fn open(db_path: &Path) -> SqlResult<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }

        // Register sqlite-vec extension BEFORE opening the connection
        unsafe {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        }

        let conn = Connection::open(db_path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;

        let mut db = Self { conn };
        db.init_schema()?;
        Ok(db)
    }

    fn init_schema(&mut self) -> SqlResult<()> {
        let has_meta: bool = self
            .conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='meta'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map(|c| c > 0)?;

        if has_meta {
            let version: Option<String> = self
                .conn
                .query_row(
                    "SELECT value FROM meta WHERE key = 'schema_version'",
                    [],
                    |r| r.get(0),
                )
                .ok();

            if let Some(v) = version {
                if v.parse::<i32>().unwrap_or(0) == SCHEMA_VERSION {
                    return Ok(());
                }
            }

            // Version mismatch — drop and recreate
            self.conn.execute_batch(
                "DROP TABLE IF EXISTS files;
                 DROP TABLE IF EXISTS symbols;
                 DROP TABLE IF EXISTS vec_symbols;
                 DROP TABLE IF EXISTS meta;",
            )?;
        }

        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (
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
            CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);",
        )?;

        self.conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
            params!["schema_version", SCHEMA_VERSION.to_string()],
        )?;
        self.conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
            params!["model", "CodeRankEmbed"],
        )?;
        self.conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
            params!["dimensions", "768"],
        )?;

        Ok(())
    }

    pub fn get_file(&self, path: &str) -> SqlResult<Option<FileRow>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT path, hash, language, symbol_count, indexed_at FROM files WHERE path = ?",
        )?;
        let mut rows = stmt.query_map(params![path], |r| {
            Ok(FileRow {
                path: r.get(0)?,
                hash: r.get(1)?,
                language: r.get(2)?,
                symbol_count: r.get(3)?,
                indexed_at: r.get(4)?,
            })
        })?;
        match rows.next() {
            Some(Ok(row)) => Ok(Some(row)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn get_all_files(&self) -> SqlResult<Vec<FileRow>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT path, hash, language, symbol_count, indexed_at FROM files",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(FileRow {
                path: r.get(0)?,
                hash: r.get(1)?,
                language: r.get(2)?,
                symbol_count: r.get(3)?,
                indexed_at: r.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn upsert_file(
        &self,
        path: &str,
        hash: &str,
        language: Option<&str>,
        symbol_count: i32,
    ) -> SqlResult<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO files (path, hash, language, symbol_count, indexed_at) VALUES (?, ?, ?, ?, ?)",
            params![path, hash, language, symbol_count, std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64],
        )?;
        Ok(())
    }

    pub fn delete_file_and_symbols(&self, file_path: &str) -> SqlResult<()> {
        self.conn.execute(
            "DELETE FROM symbols WHERE file_path = ?",
            params![file_path],
        )?;
        self.conn
            .execute("DELETE FROM files WHERE path = ?", params![file_path])?;
        Ok(())
    }

    pub fn insert_symbol(
        &self,
        embedding: &[f32],
        file_path: &str,
        name: &str,
        kind: &str,
        language: &str,
        line: i32,
        end_line: Option<i32>,
        signature: Option<&str>,
        embedding_text: &str,
    ) -> SqlResult<()> {
        let embedding_bytes = zerocopy::IntoBytes::as_bytes(embedding);
        self.conn.execute(
            "INSERT INTO symbols (embedding, file_path, name, kind, language, line, end_line, signature, embedding_text)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                embedding_bytes,
                file_path,
                name,
                kind,
                language,
                line,
                end_line,
                signature,
                embedding_text
            ],
        )?;
        Ok(())
    }

    /// Search for similar symbols using brute-force L2 distance.
    /// Score = 1 - (L2² / 2), mapping L2 distance back to cosine similarity [0,1].
    pub fn search(
        &self,
        query_embedding: &[f32],
        top_k: i32,
        language: Option<&str>,
        kind: Option<&str>,
        path_prefix: Option<&str>,
    ) -> SqlResult<Vec<SearchResult>> {
        let query_bytes = zerocopy::IntoBytes::as_bytes(query_embedding);

        let mut where_clauses = Vec::new();
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        // First param is always the query embedding
        param_values.push(Box::new(query_bytes.to_vec()));

        if let Some(prefix) = path_prefix {
            where_clauses.push("file_path LIKE ?");
            param_values.push(Box::new(format!("{}/%%", prefix)));
        }
        if let Some(lang) = language {
            where_clauses.push("language = ?");
            param_values.push(Box::new(lang.to_string()));
        }
        if let Some(k) = kind {
            where_clauses.push("kind = ?");
            param_values.push(Box::new(k.to_string()));
        }

        param_values.push(Box::new(top_k));

        let where_str = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };

        let sql = format!(
            "SELECT file_path, name, kind, language, line, end_line, signature,
                    vec_distance_l2(embedding, ?) as _dist
             FROM symbols
             {}
             ORDER BY _dist ASC
             LIMIT ?",
            where_str
        );

        let mut stmt = self.conn.prepare(&sql)?;
        let params_ref: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();

        let rows = stmt.query_map(params_ref.as_slice(), |r| {
            let dist: f64 = r.get(7)?;
            Ok(SearchResult {
                file_path: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                language: r.get(3)?,
                line: r.get(4)?,
                end_line: r.get(5)?,
                signature: r.get(6)?,
                score: 1.0 - (dist * dist) / 2.0,
            })
        })?;

        rows.collect()
    }

    pub fn get_stats(&self) -> SqlResult<Stats> {
        let symbol_count: i64 = self
            .conn
            .query_row("SELECT count(*) FROM symbols", [], |r| r.get(0))?;
        let file_count: i64 = self
            .conn
            .query_row("SELECT count(*) FROM files", [], |r| r.get(0))?;
        Ok(Stats {
            symbol_count,
            file_count,
        })
    }

    /// Begin a transaction on the underlying connection.
    pub fn transaction(&mut self) -> SqlResult<rusqlite::Transaction<'_>> {
        self.conn.transaction()
    }
}
