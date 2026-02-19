//! Benchmark: load CodeRankEmbed, embed text, measure throughput.

mod model;

use model::{mean_pool_normalize, NomicBertConfig, NomicBertModel};
use mlx_rs::{module::ModuleParametersExt, Array};
use std::{path::PathBuf, time::Instant};
use tokenizers::Tokenizer;

const MAX_LENGTH: usize = 128;
const QUERY_PREFIX: &str = "Represent this query for searching relevant code: ";

fn model_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap();
    PathBuf::from(home).join(".cache/semantic-search/models/CodeRankEmbed-safetensors")
}

fn tokenizer_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap();
    PathBuf::from(home).join(".cache/semantic-search/models/CodeRankEmbed-onnx-q8")
}

fn load_model() -> (NomicBertModel, Tokenizer) {
    let dir = model_dir();
    let tok_dir = tokenizer_dir();

    let config_str = std::fs::read_to_string(dir.join("config.json")).unwrap();
    let config: NomicBertConfig = serde_json::from_str(&config_str).unwrap();
    println!("Config: {}L, {}H, {}heads", config.n_layer, config.n_embd, config.n_head);

    let mut model = NomicBertModel::new(&config).unwrap();

    println!("Loading weights...");
    let start = Instant::now();
    model.load_safetensors(dir.join("model.safetensors")).unwrap();
    println!("Loaded in {:.1}s", start.elapsed().as_secs_f32());

    let tokenizer = Tokenizer::from_file(tok_dir.join("tokenizer.json")).unwrap();

    (model, tokenizer)
}

fn tokenize_batch(tokenizer: &Tokenizer, texts: &[&str], max_len: usize) -> (Array, Array) {
    let encodings: Vec<_> = texts
        .iter()
        .map(|t| tokenizer.encode(*t, true).unwrap())
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

    let ids = Array::from_slice(&input_ids, &[batch_size as i32, max_len as i32]);
    let mask = Array::from_slice(&attention_mask, &[batch_size as i32, max_len as i32]);
    (ids, mask)
}

fn embed_batch(
    model: &mut NomicBertModel,
    tokenizer: &Tokenizer,
    texts: &[&str],
    is_query: bool,
) -> Array {
    let prefixed: Vec<String>;
    let texts: Vec<&str> = if is_query {
        prefixed = texts.iter().map(|t| format!("{}{}", QUERY_PREFIX, t)).collect();
        prefixed.iter().map(|s| s.as_str()).collect()
    } else {
        texts.to_vec()
    };

    let (input_ids, attention_mask) = tokenize_batch(tokenizer, &texts, MAX_LENGTH);

    let hidden = model.forward(&input_ids, Some(&attention_mask)).unwrap();
    let result = mean_pool_normalize(&hidden, &attention_mask).unwrap();
    result.eval().unwrap();
    result
}

fn main() {
    println!("Device: {:?}", mlx_rs::Device::default());

    let (mut model, tokenizer) = load_model();

    let texts: Vec<&str> = vec![
        "go | packages/tcp-proxy/controller/limits.go | (c *Controller) GetHTTPRequestRateLimiterForDomain(domain string) (*rate.Limiter, error)",
        "go | packages/tcp-proxy/middleware/rate_limit.go | func RateLimitMiddleware(next http.Handler) http.Handler",
        "typescript | .pi/agent/extensions/modal-editor.ts | handleInput(data: string): void",
        "go | packages/tcp-proxy/handlers/tcp_listener/main.go | func (h *Handler) HandleConnection(conn net.Conn)",
        "typescript | .pi/agent/extensions/semantic-search/db.ts | insertSymbol(embedding: Float32Array, language: string, kind: string)",
        "rust | src/main.rs | fn main() -> Result<()>",
        "python | scripts/deploy.py | def deploy_to_production(env: str, version: str) -> bool",
        "go | packages/orchestrator/workflows/dataplane/buildandpublish.go | func (w *Workflow) Execute(ctx context.Context) error",
    ];

    // Warmup
    println!("\nWarmup...");
    for _ in 0..5 {
        let _ = embed_batch(&mut model, &tokenizer, &texts[..1], false);
    }

    let batch32_texts: Vec<&str> = (0..32).map(|i| texts[i % texts.len()]).collect();
    let (ids32, mask32) = tokenize_batch(&tokenizer, &batch32_texts, MAX_LENGTH);

    // Warmup model path
    for _ in 0..3 {
        let h = model.forward(&ids32, Some(&mask32)).unwrap();
        let r = mean_pool_normalize(&h, &mask32).unwrap();
        r.eval().unwrap();
    }

    // === Profiled forward pass at batch=32 ===
    println!("\n--- Profiled forward pass (batch=32, 10 iterations) ---");
    let n = 10;

    // Time graph construction vs eval separately
    let mut graph_total = 0.0f64;
    let mut eval_total = 0.0f64;

    for _ in 0..n {
        let t0 = Instant::now();
        let h = model.forward(&ids32, Some(&mask32)).unwrap();
        let r = mean_pool_normalize(&h, &mask32).unwrap();
        graph_total += t0.elapsed().as_secs_f64();

        let t1 = Instant::now();
        r.eval().unwrap();
        eval_total += t1.elapsed().as_secs_f64();
    }

    println!("Graph build:  {:.1}ms total, {:.2}ms/call, {:.3}ms/item",
        graph_total * 1000.0, graph_total * 1000.0 / n as f64,
        graph_total * 1000.0 / (n * 32) as f64);
    println!("Eval (GPU):   {:.1}ms total, {:.2}ms/call, {:.3}ms/item",
        eval_total * 1000.0, eval_total * 1000.0 / n as f64,
        eval_total * 1000.0 / (n * 32) as f64);
    println!("Total:        {:.3}ms/item",
        (graph_total + eval_total) * 1000.0 / (n * 32) as f64);

    // === Compare: just eval with no graph build (re-eval same graph) ===
    // Build graph once
    let h = model.forward(&ids32, Some(&mask32)).unwrap();
    let r = mean_pool_normalize(&h, &mask32).unwrap();
    r.eval().unwrap();

    // === Standard benchmark ===
    println!("\n--- Standard benchmark ---");

    let n = 20;
    let start = Instant::now();
    for i in 0..n {
        let _ = embed_batch(&mut model, &tokenizer, &texts[i % texts.len()..][..1], false);
    }
    println!("batch=1:  {:.1}ms/item (e2e)", start.elapsed().as_secs_f64() * 1000.0 / n as f64);

    let n = 10;
    let start = Instant::now();
    for _ in 0..n {
        let _ = embed_batch(&mut model, &tokenizer, &texts, false);
    }
    println!("batch=8:  {:.1}ms/item (e2e)", start.elapsed().as_secs_f64() * 1000.0 / (n * texts.len()) as f64);

    let n = 5;
    let start = Instant::now();
    for _ in 0..n {
        let _ = embed_batch(&mut model, &tokenizer, &batch32_texts, false);
    }
    println!("batch=32: {:.1}ms/item (e2e)", start.elapsed().as_secs_f64() * 1000.0 / (n * 32) as f64);

    // Correctness
    println!("\nQuery test:");
    let q = embed_batch(&mut model, &tokenizer, &["rate limiting middleware"], true);
    let data = q.as_slice::<f32>();
    println!("  first 5: {:?}", &data[..5]);
    println!("  L2 norm: {:.6}", data.iter().map(|x| x * x).sum::<f32>().sqrt());

    println!("\n--- Reference ---");
    println!("  MLX Python:      2.2ms/item at batch=32");
    println!("  ONNX CPU (int8): 14ms/item at batch=32");
}
