/// Benchmark: sqlite-vec vs simsimd, with SQLite pragma tuning
///
/// Tests against real mono repo index DB (~23K symbols).

use rusqlite::Connection;
use simsimd::SpatialSimilarity;
use std::collections::BinaryHeap;
use std::cmp::Ordering;
use std::time::Instant;

fn open_db(path: &str) -> Connection {
    unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    }
    Connection::open(path).expect("Failed to open DB")
}

fn bench_sqlite_vec(conn: &Connection, query_blob: &[u8], top_k: usize, iters: usize) -> f64 {
    let mut total = 0.0;
    for _ in 0..iters {
        let start = Instant::now();
        let mut stmt = conn
            .prepare_cached(
                "SELECT file_path, name, vec_distance_l2(embedding, ?) as _dist
                 FROM symbols ORDER BY _dist ASC LIMIT ?",
            )
            .unwrap();
        let _rows: Vec<(String, String, f64)> = stmt
            .query_map(rusqlite::params![query_blob, top_k as i64], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        total += start.elapsed().as_secs_f64() * 1000.0;
    }
    total / iters as f64
}

fn bench_simsimd_streaming(conn: &Connection, query_emb: &[f32], top_k: usize, iters: usize) -> f64 {
    let mut total = 0.0;
    for _ in 0..iters {
        let start = Instant::now();
        let mut stmt = conn
            .prepare_cached("SELECT rowid, embedding FROM symbols")
            .unwrap();
        let mut rows = stmt.query([]).unwrap();
        let mut heap: BinaryHeap<HeapItem> = BinaryHeap::new();

        while let Some(row) = rows.next().unwrap() {
            let rowid: i64 = row.get(0).unwrap();
            let blob = row.get_ref(1).unwrap().as_blob().unwrap();
            let emb: &[f32] = bytemuck::cast_slice(blob);
            let dist = f32::l2sq(query_emb, emb).unwrap();
            if heap.len() < top_k {
                heap.push(HeapItem { dist, rowid });
            } else if dist < heap.peek().unwrap().dist {
                heap.pop();
                heap.push(HeapItem { dist, rowid });
            }
        }
        total += start.elapsed().as_secs_f64() * 1000.0;
    }
    total / iters as f64
}

fn bench_simsimd_preloaded(all_emb: &[f32], dims: usize, query_emb: &[f32], top_k: usize, iters: usize) -> f64 {
    let n = all_emb.len() / dims;
    let mut total = 0.0;
    for _ in 0..iters {
        let start = Instant::now();
        let mut heap: BinaryHeap<HeapItem> = BinaryHeap::new();
        for i in 0..n {
            let emb = &all_emb[i * dims..(i + 1) * dims];
            let dist = f32::l2sq(query_emb, emb).unwrap();
            if heap.len() < top_k {
                heap.push(HeapItem { dist, rowid: i as i64 });
            } else if dist < heap.peek().unwrap().dist {
                heap.pop();
                heap.push(HeapItem { dist, rowid: i as i64 });
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

    let iters = 20;
    let top_k = 25;

    // ── Default pragmas (WAL only, current state) ──────────────────────
    println!("=== Default pragmas (WAL) ===");
    {
        let conn = open_db(&db_path);
        let count: i64 = conn.query_row("SELECT count(*) FROM symbols", [], |r| r.get(0)).unwrap();
        println!("Symbols: {}", count);

        let query_blob: Vec<u8> = conn.query_row("SELECT embedding FROM symbols LIMIT 1", [], |r| r.get(0)).unwrap();
        let query_emb: &[f32] = bytemuck::cast_slice(&query_blob);

        let t = bench_sqlite_vec(&conn, &query_blob, top_k, iters);
        println!("  sqlite-vec:        {:.2}ms", t);

        let t = bench_simsimd_streaming(&conn, query_emb, top_k, iters);
        println!("  simsimd streaming: {:.2}ms", t);
    }

    // ── Tuned pragmas ──────────────────────────────────────────────────
    println!("\n=== Tuned pragmas (mmap + cache + temp_store) ===");
    {
        let conn = open_db(&db_path);
        conn.pragma_update(None, "mmap_size", 3_000_000_000i64).ok();
        conn.pragma_update(None, "temp_store", 2).ok();
        conn.pragma_update(None, "cache_size", -64000).ok(); // 64MB

        let query_blob: Vec<u8> = conn.query_row("SELECT embedding FROM symbols LIMIT 1", [], |r| r.get(0)).unwrap();
        let query_emb: &[f32] = bytemuck::cast_slice(&query_blob);

        let t = bench_sqlite_vec(&conn, &query_blob, top_k, iters);
        println!("  sqlite-vec:        {:.2}ms", t);

        let t = bench_simsimd_streaming(&conn, query_emb, top_k, iters);
        println!("  simsimd streaming: {:.2}ms", t);
    }

    // ── Tuned + page_size test (read-only, can't change) ───────────────
    // page_size can only be set at creation time, skip

    // ── Pre-loaded (always fastest) ────────────────────────────────────
    println!("\n=== Pre-loaded simsimd ===");
    {
        let conn = open_db(&db_path);
        let count: i64 = conn.query_row("SELECT count(*) FROM symbols", [], |r| r.get(0)).unwrap();
        let dims = 768;

        let load_start = Instant::now();
        let mut all_emb = Vec::with_capacity(count as usize * dims);
        {
            let mut stmt = conn.prepare("SELECT embedding FROM symbols").unwrap();
            let mut rows = stmt.query([]).unwrap();
            while let Some(row) = rows.next().unwrap() {
                let blob = row.get_ref(0).unwrap().as_blob().unwrap();
                let emb: &[f32] = bytemuck::cast_slice(blob);
                all_emb.extend_from_slice(emb);
            }
        }
        let load_ms = load_start.elapsed().as_secs_f64() * 1000.0;
        println!("  Load: {:.1}ms ({} symbols, {:.1}MB)", load_ms, count, all_emb.len() as f64 * 4.0 / 1024.0 / 1024.0);

        let query_blob: Vec<u8> = conn.query_row("SELECT embedding FROM symbols LIMIT 1", [], |r| r.get(0)).unwrap();
        let query_emb: &[f32] = bytemuck::cast_slice(&query_blob);

        let t = bench_simsimd_preloaded(&all_emb, dims, query_emb, top_k, iters);
        println!("  Search: {:.2}ms", t);
    }

    // ── Pre-loaded with mmap ───────────────────────────────────────────
    println!("\n=== Pre-loaded simsimd (mmap DB) ===");
    {
        let conn = open_db(&db_path);
        conn.pragma_update(None, "mmap_size", 3_000_000_000i64).ok();

        let count: i64 = conn.query_row("SELECT count(*) FROM symbols", [], |r| r.get(0)).unwrap();
        let dims = 768;

        let load_start = Instant::now();
        let mut all_emb = Vec::with_capacity(count as usize * dims);
        {
            let mut stmt = conn.prepare("SELECT embedding FROM symbols").unwrap();
            let mut rows = stmt.query([]).unwrap();
            while let Some(row) = rows.next().unwrap() {
                let blob = row.get_ref(0).unwrap().as_blob().unwrap();
                let emb: &[f32] = bytemuck::cast_slice(blob);
                all_emb.extend_from_slice(emb);
            }
        }
        let load_ms = load_start.elapsed().as_secs_f64() * 1000.0;
        println!("  Load: {:.1}ms", load_ms);

        let query_blob: Vec<u8> = conn.query_row("SELECT embedding FROM symbols LIMIT 1", [], |r| r.get(0)).unwrap();
        let query_emb: &[f32] = bytemuck::cast_slice(&query_blob);

        let t = bench_simsimd_preloaded(&all_emb, dims, query_emb, top_k, iters);
        println!("  Search: {:.2}ms", t);
    }
}

#[derive(Debug)]
struct HeapItem { dist: f64, rowid: i64 }
impl PartialEq for HeapItem { fn eq(&self, other: &Self) -> bool { self.dist == other.dist } }
impl Eq for HeapItem {}
impl PartialOrd for HeapItem { fn partial_cmp(&self, other: &Self) -> Option<Ordering> { self.dist.partial_cmp(&other.dist) } }
impl Ord for HeapItem { fn cmp(&self, other: &Self) -> Ordering { self.partial_cmp(other).unwrap_or(Ordering::Equal) } }
