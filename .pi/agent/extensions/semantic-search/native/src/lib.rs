//! Native addon for semantic code search.
//!
//! Provides MLX GPU embedding (CodeRankEmbed) and SQLite+sqlite-vec storage/search.
//! Called from the TypeScript pi extension via napi-rs.
//!
//! Designed for minimal FFI overhead: batch APIs everywhere, embeddings never cross the boundary.

pub mod db;
pub mod model;

use db::SearchDB;
use model::{mean_pool_normalize, NomicBertConfig, NomicBertModel};
use mlx_rs::module::ModuleParametersExt;
use napi_derive::napi;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tokenizers::Tokenizer;

const MAX_LENGTH: usize = 128;
const QUERY_PREFIX: &str = "Represent this query for searching relevant code: ";

struct State {
    model: NomicBertModel,
    tokenizer: Tokenizer,
    db: Option<SearchDB>,
}

static STATE: std::sync::OnceLock<Mutex<State>> = std::sync::OnceLock::new();

fn with_state<T>(f: impl FnOnce(&mut State) -> napi::Result<T>) -> napi::Result<T> {
    let mutex = STATE
        .get()
        .ok_or_else(|| napi::Error::from_reason("Not initialized. Call init() first."))?;
    let mut state = mutex
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("Lock poisoned: {}", e)))?;
    f(&mut state)
}

// ── Initialization ─────────────────────────────────────────────────────

#[napi]
pub fn init(model_dir: String, tokenizer_path: String) -> napi::Result<()> {
    let model_dir = PathBuf::from(&model_dir);

    let config_str = std::fs::read_to_string(model_dir.join("config.json"))
        .map_err(|e| napi::Error::from_reason(format!("Failed to read config.json: {}", e)))?;
    let config: NomicBertConfig = serde_json::from_str(&config_str)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse config.json: {}", e)))?;

    let mut model = NomicBertModel::new(&config)
        .map_err(|e| napi::Error::from_reason(format!("Failed to create model: {}", e)))?;
    model
        .load_safetensors(model_dir.join("model.safetensors"))
        .map_err(|e| napi::Error::from_reason(format!("Failed to load weights: {}", e)))?;

    let tokenizer = Tokenizer::from_file(&tokenizer_path)
        .map_err(|e| napi::Error::from_reason(format!("Failed to load tokenizer: {}", e)))?;

    STATE
        .set(Mutex::new(State {
            model,
            tokenizer,
            db: None,
        }))
        .map_err(|_| napi::Error::from_reason("Already initialized"))?;

    Ok(())
}

#[napi]
pub fn open_db(db_path: String) -> napi::Result<()> {
    with_state(|state| {
        let db = SearchDB::open(std::path::Path::new(&db_path))
            .map_err(|e| napi::Error::from_reason(format!("Failed to open DB: {}", e)))?;
        state.db = Some(db);
        Ok(())
    })
}

#[napi]
pub fn close_db() -> napi::Result<()> {
    with_state(|state| {
        state.db = None;
        Ok(())
    })
}

// ── Internal embedding helpers ─────────────────────────────────────────

fn tokenize_batch(
    tokenizer: &Tokenizer,
    texts: &[String],
    max_len: usize,
) -> (mlx_rs::Array, mlx_rs::Array) {
    let encodings: Vec<_> = texts
        .iter()
        .map(|t| tokenizer.encode(t.as_str(), true).unwrap())
        .collect();

    let batch_size = encodings.len();
    let mut input_ids = vec![0i32; batch_size * max_len];
    let mut attention_mask = vec![0i32; batch_size * max_len];

    for (i, enc) in encodings.iter().enumerate() {
        let ids = enc.get_ids();
        let len = ids.len().min(max_len);
        for j in 0..len {
            input_ids[i * max_len + j] = ids[j] as i32;
            attention_mask[i * max_len + j] = 1;
        }
    }

    let ids = mlx_rs::Array::from_slice(&input_ids, &[batch_size as i32, max_len as i32]);
    let mask = mlx_rs::Array::from_slice(&attention_mask, &[batch_size as i32, max_len as i32]);
    (ids, mask)
}

fn embed_internal(
    model: &mut NomicBertModel,
    tokenizer: &Tokenizer,
    texts: &[String],
    is_query: bool,
) -> napi::Result<Vec<Vec<f32>>> {
    let prefixed: Vec<String> = if is_query {
        texts
            .iter()
            .map(|t| format!("{}{}", QUERY_PREFIX, t))
            .collect()
    } else {
        texts.to_vec()
    };

    let mut results = Vec::new();
    let batch_size = 32;

    for chunk in prefixed.chunks(batch_size) {
        let chunk_vec: Vec<String> = chunk.to_vec();
        let (input_ids, attention_mask) = tokenize_batch(tokenizer, &chunk_vec, MAX_LENGTH);

        let hidden = model
            .forward(&input_ids, Some(&attention_mask))
            .map_err(|e| napi::Error::from_reason(format!("Forward pass failed: {}", e)))?;
        let result = mean_pool_normalize(&hidden, &attention_mask)
            .map_err(|e| napi::Error::from_reason(format!("Pooling failed: {}", e)))?;
        result
            .eval()
            .map_err(|e| napi::Error::from_reason(format!("Eval failed: {}", e)))?;

        let data = result.as_slice::<f32>();
        let dims = result.shape();
        let n = dims[0] as usize;
        let d = dims[1] as usize;
        for i in 0..n {
            results.push(data[i * d..(i + 1) * d].to_vec());
        }
    }

    Ok(results)
}

// ── Batch DB helpers ───────────────────────────────────────────────────

fn get_db(state: &mut State) -> napi::Result<&mut SearchDB> {
    state
        .db
        .as_mut()
        .ok_or_else(|| napi::Error::from_reason("DB not opened. Call open_db() first."))
}

// ── napi types ─────────────────────────────────────────────────────────

#[napi(object)]
pub struct JsFileRow {
    pub path: String,
    pub hash: String,
    pub language: Option<String>,
    pub symbol_count: Option<i32>,
    pub indexed_at: f64,
}

#[napi(object)]
pub struct JsSearchResult {
    pub file_path: String,
    pub name: String,
    pub kind: String,
    pub language: String,
    pub line: i32,
    pub end_line: Option<i32>,
    pub signature: Option<String>,
    pub score: f64,
}

#[napi(object)]
pub struct JsStats {
    pub symbol_count: f64,
    pub file_count: f64,
}

#[napi(object)]
pub struct SymbolInput {
    pub embedding_text: String,
    pub file_path: String,
    pub name: String,
    pub kind: String,
    pub language: String,
    pub line: i32,
    pub end_line: Option<i32>,
    pub signature: Option<String>,
}

#[napi(object)]
pub struct FileInput {
    pub path: String,
    pub hash: String,
    pub language: Option<String>,
    pub symbol_count: i32,
}

#[napi(object)]
pub struct SearchFilters {
    pub language: Option<String>,
    pub kind: Option<String>,
    pub path_prefix: Option<String>,
}

// ── Batch APIs ─────────────────────────────────────────────────────────

/// Get all indexed files. Single FFI call returns everything.
#[napi]
pub fn db_get_all_files() -> napi::Result<Vec<JsFileRow>> {
    with_state(|state| {
        let db = get_db(state)?;
        let rows = db
            .get_all_files()
            .map_err(|e| napi::Error::from_reason(format!("DB error: {}", e)))?;
        Ok(rows
            .into_iter()
            .map(|r| JsFileRow {
                path: r.path,
                hash: r.hash,
                language: r.language,
                symbol_count: r.symbol_count,
                indexed_at: r.indexed_at as f64,
            })
            .collect())
    })
}

/// Delete multiple files and their symbols in a single transaction.
#[napi]
pub fn delete_files(paths: Vec<String>) -> napi::Result<()> {
    with_state(|state| {
        let db = get_db(state)?;
        let tx = db.transaction()
            .map_err(|e| napi::Error::from_reason(format!("DB error: {}", e)))?;
        for path in &paths {
            tx.execute("DELETE FROM symbols WHERE file_path = ?", rusqlite::params![path])
                .map_err(|e| napi::Error::from_reason(format!("DB error: {}", e)))?;
            tx.execute("DELETE FROM files WHERE path = ?", rusqlite::params![path])
                .map_err(|e| napi::Error::from_reason(format!("DB error: {}", e)))?;
        }
        tx.commit()
            .map_err(|e| napi::Error::from_reason(format!("DB error: {}", e)))?;
        Ok(())
    })
}

/// Upsert multiple file records in a single transaction.
#[napi]
pub fn upsert_files(files: Vec<FileInput>) -> napi::Result<()> {
    with_state(|state| {
        let db = get_db(state)?;
        let tx = db.transaction()
            .map_err(|e| napi::Error::from_reason(format!("DB error: {}", e)))?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        for f in &files {
            tx.execute(
                "INSERT OR REPLACE INTO files (path, hash, language, symbol_count, indexed_at) VALUES (?, ?, ?, ?, ?)",
                rusqlite::params![f.path, f.hash, f.language, f.symbol_count, now],
            ).map_err(|e| napi::Error::from_reason(format!("DB error: {}", e)))?;
        }
        tx.commit()
            .map_err(|e| napi::Error::from_reason(format!("DB error: {}", e)))?;
        Ok(())
    })
}

/// Embed and insert symbols in a single call.
/// Embeddings never cross the napi boundary.
/// Wraps all inserts in a transaction for performance.
#[napi]
pub fn index_symbols(symbols: Vec<SymbolInput>) -> napi::Result<()> {
    with_state(|state| {
        if symbols.is_empty() {
            return Ok(());
        }

        let texts: Vec<String> = symbols.iter().map(|s| s.embedding_text.clone()).collect();
        let embeddings = embed_internal(&mut state.model, &state.tokenizer, &texts, false)?;

        let db = get_db(state)?;
        let tx = db.transaction()
            .map_err(|e| napi::Error::from_reason(format!("DB error: {}", e)))?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT INTO symbols (embedding, file_path, name, kind, language, line, end_line, signature, embedding_text)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
            ).map_err(|e| napi::Error::from_reason(format!("DB error: {}", e)))?;

            for (sym, emb) in symbols.iter().zip(embeddings.iter()) {
                let embedding_bytes = zerocopy::IntoBytes::as_bytes(emb.as_slice());
                stmt.execute(rusqlite::params![
                    embedding_bytes,
                    sym.file_path,
                    sym.name,
                    sym.kind,
                    sym.language,
                    sym.line,
                    sym.end_line,
                    sym.signature,
                    sym.embedding_text
                ]).map_err(|e| napi::Error::from_reason(format!("DB insert error: {}", e)))?;
            }
        }
        tx.commit()
            .map_err(|e| napi::Error::from_reason(format!("DB error: {}", e)))?;
        Ok(())
    })
}

/// Multi-query search with dedup, all in Rust.
///
/// Embeds all queries as a batch, runs each against the DB,
/// deduplicates by (file_path, line, name) keeping the best score,
/// and returns top_k results sorted by score descending.
#[napi]
pub fn search(
    queries: Vec<String>,
    top_k: i32,
    threshold: f64,
    filters: SearchFilters,
) -> napi::Result<Vec<JsSearchResult>> {
    with_state(|state| {
        if queries.is_empty() {
            return Ok(Vec::new());
        }

        // Batch-embed all queries at once
        let query_embeddings =
            embed_internal(&mut state.model, &state.tokenizer, &queries, true)?;

        let db = get_db(state)?;

        // Fetch more per-query so we have enough after dedup
        let per_query_k = if queries.len() > 1 {
            (top_k as f64 * 1.5).ceil() as i32
        } else {
            top_k
        };

        // Run each query and merge results, keeping best score per symbol
        let mut best_by_key: HashMap<String, db::SearchResult> = HashMap::new();

        for emb in &query_embeddings {
            let results = db
                .search(
                    emb,
                    per_query_k,
                    filters.language.as_deref(),
                    filters.kind.as_deref(),
                    filters.path_prefix.as_deref(),
                )
                .map_err(|e| napi::Error::from_reason(format!("Search error: {}", e)))?;

            for r in results {
                let key = format!("{}:{}:{}", r.file_path, r.line, r.name);
                let existing = best_by_key.get(&key);
                if existing.map_or(true, |e| r.score > e.score) {
                    best_by_key.insert(key, r);
                }
            }
        }

        // Sort by best score, filter by threshold, take top_k
        let mut merged: Vec<_> = best_by_key
            .into_values()
            .filter(|r| r.score >= threshold)
            .collect();
        merged.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
        merged.truncate(top_k as usize);

        Ok(merged
            .into_iter()
            .map(|r| JsSearchResult {
                file_path: r.file_path,
                name: r.name,
                kind: r.kind,
                language: r.language,
                line: r.line,
                end_line: r.end_line,
                signature: r.signature,
                score: r.score,
            })
            .collect())
    })
}

#[napi]
pub fn db_get_stats() -> napi::Result<JsStats> {
    with_state(|state| {
        let db = get_db(state)?;
        let stats = db
            .get_stats()
            .map_err(|e| napi::Error::from_reason(format!("DB error: {}", e)))?;
        Ok(JsStats {
            symbol_count: stats.symbol_count as f64,
            file_count: stats.file_count as f64,
        })
    })
}
