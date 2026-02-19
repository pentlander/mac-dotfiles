# GPU-Accelerated Embeddings via MLX + napi-rs

## Summary

Replace the ONNX Runtime CPU embedder with a native Rust addon using
[mlx-rs](https://github.com/oxideai/mlx-rs) (Rust bindings for Apple's MLX framework)
and [napi-rs](https://napi.rs) for Node.js integration. MLX runs on Metal GPU via
Apple Silicon's unified memory — zero-copy between CPU and GPU.

## Benchmarks

All benchmarks on Apple Silicon, CodeRankEmbed (137M param NomicBert), float32 weights.

| Backend                        | Batch=1  | Batch=8  | Batch=32 |
|--------------------------------|----------|----------|----------|
| **MLX (Metal GPU, Python)**    | 9.4ms    | 3.7ms    | **2.2ms/item** |
| Swift MLTensor (CoreML GPU)    | 183ms    | 28ms     | 7.5ms    |
| Candle CPU + Accelerate (f32)  | 18ms     | 9ms      | 7.8ms    |
| ONNX Runtime CPU (int8, current) | 17ms   | 15ms     | **14ms/item** |

MLX is **6.4x faster** than the current ONNX setup at batch=32.

For 700 symbols (typical scoped index): **~1.5s** vs current ~10s.
For 25K symbols (full monorepo): **~55s** vs current ~6min.

## Why MLX over alternatives

| Approach | Result | Issue |
|---|---|---|
| ONNX Runtime + CoreML EP | ❌ Slower than CPU | Only 28% of int8 ops on CoreML; constant CPU↔GPU data transfers |
| Candle + Metal | ❌ Crashes | No Metal LayerNorm kernel in candle (BERT uses it heavily) |
| CoreML native (coremltools convert) | ❌ Can't export | NomicBert's rotary embeddings have data-dependent shapes; untraceable by torch.jit/torch.export |
| Candle CPU + Accelerate | ✅ 7.8ms/item | Good fallback, but still CPU-only |
| Swift MLTensor (swift-embeddings) | ✅ 7.5ms/item | Uses CoreML's MLTensor, not MLX. High single-item latency (183ms). |
| **MLX (Metal GPU)** | ✅ **2.2ms/item** | Unified memory, zero-copy, custom Metal kernels for all ops including LayerNorm |

Key: MLX has native Metal kernels for **all** ops BERT/NomicBert needs (LayerNorm, rotary
embeddings, SwiGLU, softmax, matmul). No op coverage gaps. Apple Silicon's unified memory
means tensors are never copied between CPU and GPU — they share the same physical RAM.

## Architecture

```
semantic-search/
├── native/                        # New Rust crate (napi-rs addon)
│   ├── Cargo.toml
│   ├── src/
│   │   ├── lib.rs                 # napi exports: init, embed, is_gpu
│   │   └── nomic_bert.rs          # NomicBert model (port from Python)
│   └── build.rs                   # napi build config
├── embedder.ts                    # Modified: try native, fall back to ONNX
├── db.ts                          # Unchanged
├── chunker.ts                     # Unchanged
├── indexer.ts                     # Unchanged
└── index.ts                       # Unchanged
```

## Implementation

### Step 1: Rust crate — `native/Cargo.toml` (~25 lines)

```toml
[package]
name = "semantic-search-native"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
mlx-rs = { git = "https://github.com/oxideai/mlx-rs" }
napi = { version = "2", features = ["napi8"] }
napi-derive = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokenizers = "0.20"

[build-dependencies]
napi-build = "2"
```

### Step 2: NomicBert model — `native/src/nomic_bert.rs` (~150 lines)

Port of the ~100-line Python NomicBert we wrote and benchmarked. Uses mlx-rs equivalents:

- `mlx_rs::nn::Linear` → linear projections (Wqkv, out_proj, fc11, fc12, fc2)
- `mlx_rs::nn::LayerNorm` → norm1, norm2, emb_ln
- `mlx_rs::nn::Embedding` → word embeddings
- Manual rotary embedding implementation (~30 lines, same math as Python)
- `mlx_rs::ops::softmax`, `mlx_rs::nn::silu` → attention + SwiGLU activation

Weight loading from safetensors via `mlx_rs::Array::from_safetensors` with key remapping
(same mapping as the Python benchmark: `model.encoder.layers.N.` → `layers.N.`).

### Step 3: napi exports — `native/src/lib.rs` (~80 lines)

```rust
use std::sync::OnceLock;

static MODEL: OnceLock<(NomicBertModel, Tokenizer)> = OnceLock::new();

#[napi]
fn init(model_dir: String) -> napi::Result<()> {
    // Load config.json, tokenizer.json, model.safetensors
    // Initialize NomicBertModel with weights
    // Store in MODEL OnceLock
}

#[napi]
fn embed(texts: Vec<String>, is_query: bool) -> napi::Result<Vec<Vec<f32>>> {
    // Prepend query prefix if is_query
    // Tokenize with padding/truncation (max_length=128)
    // Forward pass through NomicBertModel
    // Mean pooling (masked by attention_mask)
    // L2 normalize
    // mx::eval() to materialize
    // Return as Vec<Vec<f32>>
}

#[napi]
fn is_gpu() -> bool {
    // mlx always uses Metal on Apple Silicon
    true
}
```

### Step 4: JS integration — `embedder.ts` changes (~30 lines)

```typescript
let native: { init: Function; embed: Function; is_gpu: Function } | null = null;
try {
  native = require("./native/semantic-search-native.node");
} catch {}

// In Embedder.init():
if (native) {
  native.init(modelDir);
  return;
}
// ... existing ONNX init ...

// In Embedder.embed():
if (native) {
  return native.embed(texts, isQuery);
}
// ... existing ONNX embed ...
```

Same public API. All callers (indexer, search) are unaffected.

### Step 5: Model files

Download from `nomic-ai/CodeRankEmbed` on HuggingFace (not gated):
- `model.safetensors` (523MB float32) — already downloaded at
  `~/.cache/semantic-search/models/CodeRankEmbed-safetensors/`
- `config.json` (1.5KB) — already downloaded
- `tokenizer.json` — already cached from ONNX setup

Future optimization: convert to float16 (~260MB). MLX handles f16 natively on Metal.

### Step 6: Build

```json
// package.json
"scripts": {
  "build:native": "cd native && cargo build --release && cp target/release/libsemantic_search_native.dylib ../semantic-search-native.node"
}
```

Or use `@napi-rs/cli` for proper prebuild workflow.

## Code estimate

| Component              | Lines | Notes                                          |
|------------------------|-------|-------------------------------------------------|
| `Cargo.toml`           | ~25   | Dependencies + napi config                      |
| `build.rs`             | ~5    | napi-build boilerplate                           |
| `src/nomic_bert.rs`    | ~150  | Model code (port from Python benchmark)          |
| `src/lib.rs`           | ~80   | napi exports, tokenization, pooling, init        |
| `embedder.ts` changes  | ~30   | Try native, fall back to ONNX                   |
| **Total**              | **~290** |                                               |

## Expected performance

| Metric      | Current (ONNX CPU) | MLX (Metal GPU)  | Speedup |
|-------------|--------------------:|------------------:|--------:|
| Per item    | 14ms               | ~2.2ms            | 6.4x    |
| Query embed | 17ms               | ~9ms              | 1.9x    |
| 700 symbols | 10s                | ~1.5s             | 6.7x    |
| 25K symbols | 6min               | ~55s              | 6.5x    |

## Risks

- **mlx-rs maturity**: Unofficial bindings, may have API gaps or bugs. Fallback: use MLX
  C++ API directly via `cc` crate, or shell out to a Swift CLI using
  [mlx-swift](https://github.com/ml-explore/mlx-swift).
- **Apple Silicon only**: MLX requires Metal. Non-Apple machines fall back to ONNX CPU
  (already working). This is fine for a personal tool.
- **Model size**: 523MB float32 safetensors vs 138MB int8 ONNX. Can reduce to ~260MB
  with float16 conversion (no quality loss for embeddings).
- **Rust toolchain required**: Need `cargo` installed to build. One-time setup.
- **napi-rs ABI**: Native addon tied to Node.js ABI version. May need rebuild on
  Node.js major version upgrades.

## Fallback chain

1. Try loading `semantic-search-native.node` (MLX Metal GPU)
2. If not found or load fails → fall back to ONNX Runtime CPU (current implementation)
3. Both produce identical embeddings (same model weights, same tokenizer)

## Alternatives considered (with benchmark data)

See benchmarks at top. Full evaluation notes:

- **ONNX Runtime CoreML EP**: int8 model — 483/1731 ops on CoreML (28%), 65ms/item (4.6x slower).
  float32 model — 246/569 ops on CoreML (43%), crashes on batch>1, 52ms/item at batch=1.
- **Candle + Metal**: `BertModel` built-in but candle's Metal backend has no `layer_norm.metal`
  kernel. Errors at runtime. CPU+Accelerate mode works at 7.8ms/item (good fallback).
- **Swift MLTensor** (swift-embeddings): Uses CoreML's MLTensor, not MLX. 7.5ms/item at
  batch=32 but 183ms at batch=1 (GPU dispatch overhead). Would need Swift CLI + subprocess.
- **CoreML native** (coremltools convert): NomicBert uses data-dependent rotary embeddings
  that are untraceable by torch.jit.trace, torch.export, and torch.onnx.export.
- **node-mlx** (@frost-beta/mlx): All primitives exist but BERT not built-in (need ~200 lines
  JS model code). Package not actively maintained.
