/// Benchmark: 4KB vs 16KB SQLite page size for mmap streaming search

use rusqlite::Connection;
use simsimd::SpatialSimilarity;
use std::collections::BinaryHeap;
use std::cmp::Ordering;
use std::time::Instant;

fn open_db(path: &str) -> Connection {
    let conn = Connection::open(path).expect("Failed to open DB");
    conn.pragma_update(None, "mmap_size", 3_000_000_000i64).ok();
    conn.pragma_update(None, "temp_store", 2).ok();
    conn.pragma_update(None, "cache_size", -64000).ok();
    conn
}

fn create_db_with_page_size(path: &str, page_size: i32) -> Connection {
    let _ = std::fs::remove_file(path);
    let conn = Connection::open(path).expect("Failed to create DB");
    // page_size must be set BEFORE any tables
    conn.pragma_update(None, "page_size", page_size).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.pragma_update(None, "mmap_size", 3_000_000_000i64).ok();
    conn.pragma_update(None, "temp_store", 2).ok();
    conn.pragma_update(None, "cache_size", -64000).ok();

    conn.execute_batch(
        "CREATE TABLE symbols (
            file_path TEXT NOT NULL,
            line INTEGER NOT NULL,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            language TEXT NOT NULL,
            end_line INTEGER,
            signature TEXT,
            embedding_text TEXT NOT NULL,
            embedding BLOB NOT NULL,
            PRIMARY KEY (file_path, line)
        ) WITHOUT ROWID;",
    ).unwrap();
    conn
}

fn copy_symbols(src: &Connection, dst: &Connection) {
    let mut read_stmt = src.prepare(
        "SELECT file_path, line, name, kind, language, end_line, signature, embedding_text, embedding FROM symbols"
    ).unwrap();
    let mut write_stmt = dst.prepare(
        "INSERT INTO symbols (file_path, line, name, kind, language, end_line, signature, embedding_text, embedding) VALUES (?,?,?,?,?,?,?,?,?)"
    ).unwrap();

    let mut rows = read_stmt.query([]).unwrap();
    while let Some(row) = rows.next().unwrap() {
        let file_path: String = row.get(0).unwrap();
        let line: i32 = row.get(1).unwrap();
        let name: String = row.get(2).unwrap();
        let kind: String = row.get(3).unwrap();
        let language: String = row.get(4).unwrap();
        let end_line: Option<i32> = row.get(5).unwrap();
        let signature: Option<String> = row.get(6).unwrap();
        let embedding_text: String = row.get(7).unwrap();
        let embedding: Vec<u8> = row.get(8).unwrap();
        write_stmt.execute(rusqlite::params![
            file_path, line, name, kind, language, end_line, signature, embedding_text, embedding
        ]).unwrap();
    }
}

fn bench_streaming(conn: &Connection, query_emb: &[f32], top_k: usize, iters: usize) -> f64 {
    let mut total = 0.0;
    for _ in 0..iters {
        let start = Instant::now();
        let mut stmt = conn.prepare_cached(
            "SELECT file_path, line, name, kind, language, end_line, signature, embedding FROM symbols"
        ).unwrap();
        let mut rows = stmt.query([]).unwrap();
        let mut heap: BinaryHeap<HeapItem> = BinaryHeap::with_capacity(top_k + 1);

        while let Some(row) = rows.next().unwrap() {
            let blob = row.get_ref(7).unwrap().as_blob().unwrap();
            let emb: &[f32] = bytemuck::cast_slice(blob);
            let dist = f32::l2sq(query_emb, emb).unwrap();

            if heap.len() < top_k {
                heap.push(HeapItem { dist, id: 0 });
            } else if dist < heap.peek().unwrap().dist {
                heap.pop();
                heap.push(HeapItem { dist, id: 0 });
            }
        }
        total += start.elapsed().as_secs_f64() * 1000.0;
    }
    total / iters as f64
}

fn main() {
    let db_path = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("Usage: search_bench <path-to-index.db>");
        eprintln!("  e.g. search_bench ~/myrepo/.code-search-cache/index.db");
        std::process::exit(1);
    });

    let iters = 30;
    let top_k = 25;

    let src = open_db(&db_path);
    let count: i64 = src.query_row("SELECT count(*) FROM symbols", [], |r| r.get(0)).unwrap();
    println!("Source DB: {} symbols", count);

    let src_page_size: i64 = src.pragma_query_value(None, "page_size", |r| r.get(0)).unwrap();
    println!("Source page_size: {}", src_page_size);

    // Get a query embedding
    let query_blob: Vec<u8> = src.query_row("SELECT embedding FROM symbols LIMIT 1", [], |r| r.get(0)).unwrap();
    let query_emb: &[f32] = bytemuck::cast_slice(&query_blob);

    // Bench source DB (4KB pages)
    println!("\n=== {}KB pages (source) ===", src_page_size / 1024);
    let t = bench_streaming(&src, query_emb, top_k, iters);
    println!("  Streaming search: {:.2}ms", t);

    // Create 4KB copy (control)
    let tmp_4k = "/tmp/bench_4k.db";
    println!("\n=== 4KB pages (fresh copy) ===");
    {
        let dst = create_db_with_page_size(tmp_4k, 4096);
        copy_symbols(&src, &dst);
        let ps: i64 = dst.pragma_query_value(None, "page_size", |r| r.get(0)).unwrap();
        let file_size = std::fs::metadata(tmp_4k).unwrap().len();
        println!("  page_size: {}, file: {:.1}MB", ps, file_size as f64 / 1024.0 / 1024.0);

        // Drop page cache by reopening
        drop(dst);
        let dst = open_db(tmp_4k);
        let t = bench_streaming(&dst, query_emb, top_k, iters);
        println!("  Streaming search: {:.2}ms", t);
    }

    // Create 8KB copy
    let tmp_8k = "/tmp/bench_8k.db";
    println!("\n=== 8KB pages ===");
    {
        let dst = create_db_with_page_size(tmp_8k, 8192);
        copy_symbols(&src, &dst);
        let ps: i64 = dst.pragma_query_value(None, "page_size", |r| r.get(0)).unwrap();
        let file_size = std::fs::metadata(tmp_8k).unwrap().len();
        println!("  page_size: {}, file: {:.1}MB", ps, file_size as f64 / 1024.0 / 1024.0);

        drop(dst);
        let dst = open_db(tmp_8k);
        let t = bench_streaming(&dst, query_emb, top_k, iters);
        println!("  Streaming search: {:.2}ms", t);
    }

    // Create 16KB copy (matches OS page size)
    let tmp_16k = "/tmp/bench_16k.db";
    println!("\n=== 16KB pages (matches OS) ===");
    {
        let dst = create_db_with_page_size(tmp_16k, 16384);
        copy_symbols(&src, &dst);
        let ps: i64 = dst.pragma_query_value(None, "page_size", |r| r.get(0)).unwrap();
        let file_size = std::fs::metadata(tmp_16k).unwrap().len();
        println!("  page_size: {}, file: {:.1}MB", ps, file_size as f64 / 1024.0 / 1024.0);

        drop(dst);
        let dst = open_db(tmp_16k);
        let t = bench_streaming(&dst, query_emb, top_k, iters);
        println!("  Streaming search: {:.2}ms", t);
    }

    // Create 32KB copy
    let tmp_32k = "/tmp/bench_32k.db";
    println!("\n=== 32KB pages ===");
    {
        let dst = create_db_with_page_size(tmp_32k, 32768);
        copy_symbols(&src, &dst);
        let ps: i64 = dst.pragma_query_value(None, "page_size", |r| r.get(0)).unwrap();
        let file_size = std::fs::metadata(tmp_32k).unwrap().len();
        println!("  page_size: {}, file: {:.1}MB", ps, file_size as f64 / 1024.0 / 1024.0);

        drop(dst);
        let dst = open_db(tmp_32k);
        let t = bench_streaming(&dst, query_emb, top_k, iters);
        println!("  Streaming search: {:.2}ms", t);
    }

    // Create 65KB copy
    let tmp_64k = "/tmp/bench_64k.db";
    println!("\n=== 64KB pages ===");
    {
        let dst = create_db_with_page_size(tmp_64k, 65536);
        copy_symbols(&src, &dst);
        let ps: i64 = dst.pragma_query_value(None, "page_size", |r| r.get(0)).unwrap();
        let file_size = std::fs::metadata(tmp_64k).unwrap().len();
        println!("  page_size: {}, file: {:.1}MB", ps, file_size as f64 / 1024.0 / 1024.0);

        drop(dst);
        let dst = open_db(tmp_64k);
        let t = bench_streaming(&dst, query_emb, top_k, iters);
        println!("  Streaming search: {:.2}ms", t);
    }

    // Cleanup
    for f in [tmp_4k, tmp_8k, tmp_16k, tmp_32k, tmp_64k] {
        std::fs::remove_file(f).ok();
        std::fs::remove_file(format!("{}-wal", f)).ok();
        std::fs::remove_file(format!("{}-shm", f)).ok();
    }
}

#[derive(Debug)]
struct HeapItem { dist: f64, id: i64 }
impl PartialEq for HeapItem { fn eq(&self, other: &Self) -> bool { self.dist == other.dist } }
impl Eq for HeapItem {}
impl PartialOrd for HeapItem { fn partial_cmp(&self, other: &Self) -> Option<Ordering> { self.dist.partial_cmp(&other.dist) } }
impl Ord for HeapItem { fn cmp(&self, other: &Self) -> Ordering { self.partial_cmp(other).unwrap_or(Ordering::Equal) } }
