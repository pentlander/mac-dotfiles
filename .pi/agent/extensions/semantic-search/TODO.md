# Semantic Search — TODO

## GPU Acceleration via Candle + napi-rs

Currently embedding runs on CPU via ONNX Runtime (~14ms/item, ~10s for 700 symbols).
Candle (Rust ML framework by HuggingFace) with Metal backend could bring this to ~1-2ms/item.

### Why Candle over alternatives

- **ONNX Runtime CoreML EP**: Tested, slower than CPU. Only 28% of int8 ops supported,
  constant CPU↔GPU data transfers for unsupported ops negate any speedup.
- **node-mlx (@frost-beta/mlx)**: MLX is ideal for Apple Silicon (unified memory, zero-copy),
  but requires implementing BERT forward pass from scratch (~200 lines JS) and the
  package isn't actively maintained.
- **candle**: Has `BertModel` built-in via `candle-transformers`. Metal backend compiles
  all ops to Metal shaders — entire forward pass runs on GPU with one copy in, one copy out.
  Rust + napi-rs is a well-trodden path for Node native addons.

### Plan

```
semantic-search/
├── native/                    # New Rust crate
│   ├── Cargo.toml             # ~20 lines
│   └── src/lib.rs             # ~120 lines — napi exports + BERT inference
├── embedder.ts                # Modified: try native, fall back to ONNX
└── ...                        # Everything else unchanged
```

**Rust crate (`native/`):**

Dependencies: `candle-core` (with `metal` feature), `candle-nn`, `candle-transformers`,
`tokenizers`, `napi`, `napi-derive`, `serde_json`.

Three napi exports:
1. `init(model_dir: string)` — load config.json, tokenizer.json, model.safetensors;
   try `Device::new_metal(0)`, fall back to `Device::Cpu`; store in `OnceLock`.
2. `embed(texts: Vec<String>, is_query: bool) -> Vec<Float32Array>` — tokenize,
   forward pass, mean pooling (masked), L2 normalize.
3. `is_gpu() -> bool` — report whether Metal is active.

Almost all logic is adapted from candle's existing
[bert example](https://github.com/huggingface/candle/blob/main/candle-examples/examples/bert/main.rs).

**Model files:** Download from `pints-ai/CodeRankEmbed` on HuggingFace:
- `model.safetensors` — use float16 (~260MB). Metal handles f16 natively,
  half the size of float32, same quality for embeddings.
- `config.json` (~1KB)
- `tokenizer.json` (already cached from ONNX setup)

**JS integration (~30 lines):** `embedder.ts` tries `require("./native/...")`,
falls back to ONNX. Same public API, transparent to callers.

### Expected performance

| Metric       | CPU (ONNX, current) | Metal (candle) |
|--------------|---------------------|----------------|
| Per item     | ~14ms               | ~1-2ms (est.)  |
| 700 symbols  | ~10s                | ~1-1.5s        |
| 25K symbols  | ~6min               | ~30-50s        |

### Total new code: ~195 lines

| Component            | Lines | Notes                                |
|----------------------|-------|--------------------------------------|
| Cargo.toml           | ~20   | Dependencies + napi config           |
| src/lib.rs           | ~120  | Adapted from candle bert example     |
| embedder.ts changes  | ~30   | Try native, fall back to ONNX        |
| Download tweaks      | ~10   | Add safetensors + config.json        |
| Build scripts        | ~15   | cargo build + copy .node file        |

### Risks

- candle Metal op coverage for BERT (should be fine — standard ops)
- napi-rs build requires Rust toolchain
- float16 model is 260MB vs 138MB for current int8 ONNX

## Other

- [ ] Flatten TOML/YAML sections with key=value pairs in embedding text
      (e.g. `sources.usage_metrics: type=http_server, address=0.0.0.0:9757`)
      for better semantic matching on config file contents
- [ ] Background re-indexing on file changes
- [ ] Configurable exclude patterns (beyond .gitignore)
- [ ] Status widget showing index state
