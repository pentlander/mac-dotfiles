# GPU-Accelerated Embedding & Search via mlx-rs + napi-rs

## Summary

Replace `embedder.ts` (ONNX Runtime CPU) and `db.ts` (better-sqlite3 + sqlite-vec)
with a single Rust native addon using [mlx-rs](https://github.com/oxideai/mlx-rs) for
Metal GPU inference and [rusqlite](https://github.com/rusqlite/rusqlite) + sqlite-vec
for storage/search. Exposed to Node.js via [napi-rs](https://napi.rs).

Tree-sitter parsing, file walking, and pi extension registration stay in TypeScript.

## Benchmarks

All benchmarks on Apple Silicon M4 Max, CodeRankEmbed (137M param, 12-layer NomicBert), float32.

| Backend                          | Batch=1  | Batch=8    | Batch=32     |
|----------------------------------|----------|------------|--------------|
| **MLX Metal GPU (Python)**       | **9.4ms**| **3.7ms**  | **2.2ms/item** |
| Swift MLTensor (CoreML GPU)      | 183ms    | 28ms       | 7.5ms        |
| Candle CPU + Accelerate (f32)    | 18ms     | 9ms        | 7.8ms        |
| ONNX Runtime CPU (int8, current) | 17ms     | 15ms       | 14ms         |

MLX is **6.4x faster** than ONNX at batch=32. Rust mlx-rs calls the same
underlying MLX C library + Metal kernels as Python MLX, so performance should match.

| Workload     | Current (ONNX CPU) | MLX Metal    | Speedup |
|--------------|-------------------:|-------------:|--------:|
| Query embed  | 17ms               | ~9ms         | 1.9x    |
| 700 symbols  | ~10s               | ~1.5s        | 6.7x    |
| 25K symbols  | ~6min              | ~55s         | 6.5x    |

## Architecture

```
semantic-search/
├── native/                          # Rust crate (napi-rs cdylib)
│   ├── Cargo.toml
│   ├── build.rs                     # napi-build
│   └── src/
│       ├── lib.rs                   # napi exports: init, embed, search, index_symbols, ...
│       ├── model.rs                 # NomicBert implementation (~150 lines)
│       └── db.rs                    # rusqlite + sqlite-vec wrapper (~100 lines)
├── index.ts                         # Unchanged — pi tool registration
├── chunker.ts                       # Unchanged — tree-sitter → ChunkInfo[]
├── indexer.ts                       # Simplified — delegates embed+store to native
├── embedder.ts                      # Thin wrapper: try native, fall back to ONNX
├── db.ts                            # Thin wrapper: try native, fall back to better-sqlite3
└── package.json
```

## mlx-rs API surface (verified from source)

Everything we need exists in the crate (v0.25.3, published on crates.io):

| Need               | mlx-rs                                       |
|---------------------|----------------------------------------------|
| Embedding layer     | `mlx_rs::nn::Embedding`                      |
| Linear layer        | `mlx_rs::nn::Linear` (with bias toggle)      |
| LayerNorm           | `mlx_rs::nn::LayerNorm`                      |
| Rotary embeddings   | `mlx_rs::nn::Rope` (built-in, configurable)  |
| SiLU activation     | `mlx_rs::nn::Silu`                           |
| Softmax             | `mlx_rs::ops::softmax`                       |
| Matmul              | `mlx_rs::ops::matmul`                        |
| Safetensors loading | `ModuleParametersExt::load_safetensors(path)` |
| Lazy eval + materialize | `mlx_rs::transforms::eval()`             |
| Weight key remapping| `ModuleParameters::update_flattened(HashMap)` |

Build requires: Rust toolchain, cmake, Xcode CLT (for Metal shader compiler `xcrun metal`).

## Implementation details

### Model: `native/src/model.rs` (~150 lines)

NomicBert with CodeRankEmbed's specific config:
- 12 layers, 768 hidden, 12 heads, 64 head_dim
- Rotary embeddings: fraction=1.0, base=1000, non-interleaved
- SwiGLU MLP: fc11 (gate_proj) + fc12 (up_proj) → SiLU gate * up → fc2 (down_proj)
- Post-norm (prenorm=false): `norm(x + attn(x))`, `norm(x + mlp(x))`
- No QKV bias, no MLP bias
- Word embeddings + embedding LayerNorm (no position embeddings — RoPE handles position)

Weight key mapping (safetensors → struct fields):
```
embeddings.word_embeddings.weight  →  embeddings.weight
emb_ln.{weight,bias}              →  emb_ln.{weight,bias}
encoder.layers.N.attn.Wqkv.weight →  layers.N.attn.wqkv.weight
encoder.layers.N.attn.out_proj.*  →  layers.N.attn.out_proj.*
encoder.layers.N.mlp.fc11.*       →  layers.N.mlp.fc11.*
encoder.layers.N.mlp.fc12.*       →  layers.N.mlp.fc12.*
encoder.layers.N.mlp.fc2.*        →  layers.N.mlp.fc2.*
encoder.layers.N.norm1.*          →  layers.N.norm1.*
encoder.layers.N.norm2.*          →  layers.N.norm2.*
```
112 weight tensors total.

### Database: `native/src/db.rs` (~100 lines)

Same schema as current `db.ts` (schema version 3):
- `meta` table (schema_version, model, dimensions)
- `files` table (path, hash, language, symbol_count, indexed_at)
- `symbols` table (id, embedding BLOB, file_path, name, kind, language, line, end_line, signature, embedding_text)
- Indexes on file_path, language, kind
- `vec_distance_l2()` from sqlite-vec for brute-force KNN

Uses `rusqlite` with sqlite-vec loaded via `Connection::load_extension()`.
Prepared statements cached. WAL mode.

### napi exports: `native/src/lib.rs` (~120 lines)

```rust
// Model lifecycle
#[napi] fn init(model_dir: String, db_path: String) -> Result<()>
#[napi] fn is_gpu() -> bool

// Embedding
#[napi] fn embed(texts: Vec<String>, is_query: bool) -> Result<Vec<Vec<f32>>>
#[napi] fn embed_query(query: String) -> Result<Vec<f32>>

// Database
#[napi] fn db_upsert_file(path: String, hash: String, lang: String, count: i32) -> Result<()>
#[napi] fn db_delete_file(path: String) -> Result<()>
#[napi] fn db_get_file(path: String) -> Result<Option<FileRow>>
#[napi] fn db_get_all_files() -> Result<Vec<FileRow>>
#[napi] fn db_insert_symbols(symbols: Vec<SymbolInput>) -> Result<()>  // batched
#[napi] fn db_search(query_embedding: Vec<f32>, top_k: i32, filters: SearchFilters) -> Result<Vec<SearchResult>>
#[napi] fn db_get_stats() -> Result<Stats>
#[napi] fn db_close() -> Result<()>
```

Model + DB stored in `OnceLock<(NomicBert, Connection)>`. Single-threaded access
(napi main thread only — fine for our use case).

### TypeScript changes

**`embedder.ts`** (~40 lines total, mostly delegation):
```typescript
let native: NativeModule | null = null;
try { native = require("./native/index.node"); } catch {}

export class Embedder {
  async init() {
    if (native) { native.init(modelDir, dbPath); return; }
    // ... existing ONNX init ...
  }
  async embed(texts, isQuery) {
    if (native) return native.embed(texts, isQuery);
    // ... existing ONNX embed ...
  }
}
```

**`db.ts`**: Same pattern — try native, fall back to better-sqlite3.

**`indexer.ts`**: No changes needed — it calls `embedder.embed()` and `db.insertSymbol()`
which transparently route to native.

**`index.ts`**: No changes.

**`chunker.ts`**: No changes.

### Cargo.toml

```toml
[package]
name = "semantic-search-native"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
mlx-rs = "0.25"
napi = { version = "2", features = ["napi8"] }
napi-derive = "2"
rusqlite = { version = "0.32", features = ["bundled"] }
tokenizers = { version = "0.20", default-features = false }
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[build-dependencies]
napi-build = "2"
```

## Model files

Already downloaded at `~/.cache/semantic-search/models/CodeRankEmbed-safetensors/`:
- `model.safetensors` (523MB float32)
- `config.json` (1.5KB)
- `tokenizer.json` (already cached from ONNX setup at `CodeRankEmbed-onnx-q8/`)

Future: convert to float16 (261MB) — MLX Metal handles f16 natively, same quality for embeddings.

## Build

```bash
cd native && cargo build --release
# Produces: target/release/libsemantic_search_native.dylib
# Copy/symlink as: native/index.node
```

Or use `@napi-rs/cli` for proper packaging:
```bash
npx napi build --release --platform
```

Build requires: Rust 1.83+, cmake, Xcode CLT (for `xcrun metal` shader compiler).

## Code estimate

| File                    | Lines | Notes                                        |
|-------------------------|-------|----------------------------------------------|
| `Cargo.toml`            | ~20   | Dependencies + napi config                   |
| `build.rs`              | ~5    | napi-build boilerplate                       |
| `src/model.rs`          | ~150  | NomicBert (port from Python benchmark)       |
| `src/db.rs`             | ~100  | rusqlite + sqlite-vec                        |
| `src/lib.rs`            | ~120  | napi exports, tokenization, pooling          |
| `embedder.ts` changes   | ~20  | Try native, fall back to ONNX               |
| `db.ts` changes          | ~20  | Try native, fall back to better-sqlite3      |
| **Total new Rust**       | **~395** |                                           |
| **Total TS changes**     | **~40**  |                                           |

## Fallback chain

1. Try loading `native/index.node` (MLX Metal GPU + rusqlite)
2. If not found or load fails → fall back to ONNX CPU + better-sqlite3 (current impl)
3. Both produce compatible embeddings (same model, same tokenizer, same pooling)

Note: float32 MLX embeddings vs int8 ONNX embeddings will differ slightly due to
quantization. If switching backends, a `/reindex` is needed.

## Risks

| Risk | Mitigation |
|------|------------|
| **mlx-rs build needs Xcode CLT** (Metal shader compiler) | Document in README; ONNX fallback works without it |
| **mlx-rs is unofficial** (community-maintained) | v0.25.3 on crates.io, 9K downloads, active development; worst case: use MLX C API directly |
| **Apple Silicon only** | MLX requires Metal. ONNX fallback for other platforms |
| **Model size** (523MB f32 vs 138MB int8) | Convert to f16 (261MB); or keep both cached |
| **napi ABI versioning** | Rebuild on Node.js major upgrades; prebuilt binaries optional |
| **sqlite-vec Rust loading** | Use `rusqlite::Connection::load_extension()` with the sqlite-vec shared lib, or statically link |
| **Weight key mismatch** | Key mapping verified against actual safetensors (112 keys, pattern documented above) |

## Alternatives evaluated

| Approach | Batch=32 | Status |
|----------|----------|--------|
| MLX (Metal GPU) — this plan | 2.2ms/item | ✅ Benchmarked |
| Candle + Metal | — | ❌ No Metal LayerNorm kernel |
| Candle CPU + Accelerate | 7.8ms/item | ✅ Works, 3.5x slower than MLX |
| Swift MLTensor (CoreML) | 7.5ms/item | ✅ Works, 3.4x slower than MLX |
| ONNX CoreML EP | 65ms/item | ❌ Only 28% ops on CoreML |
| CoreML native export | — | ❌ NomicBert untraceable |
