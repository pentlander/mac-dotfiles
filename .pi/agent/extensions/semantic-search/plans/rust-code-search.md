# Rust Embed + Search CLI

## Idea

Move embedding and vector search to Rust. Keep tree-sitter parsing in TypeScript.

**Rust CLI handles:**
- MLX embedding (via mlx-rs, Metal GPU)
- SQLite + sqlite-vec storage
- Vector search with filtering
- Tokenization (HuggingFace `tokenizers` crate)

**TypeScript keeps:**
- File walking + .gitignore
- Tree-sitter parsing (22 languages, WASM grammars)
- Symbol extraction + signature formatting
- pi extension tool registration

TypeScript formats chunks → passes to Rust CLI for embed/store/search.

## Interface (rough)

```bash
# Index: accepts JSONL on stdin, each line = {text, file_path, line, name, kind, language, content_hash}
code-search index --db /path/to/index.db < chunks.jsonl

# Search: returns top-k results as JSON
code-search search --db /path/to/index.db --top-k 25 "rate limiting middleware"

# Multi-query
code-search search --db /path/to/index.db "rate limiting" "request throttling"

# Prune: remove symbols not in provided hash set
code-search prune --db /path/to/index.db < current_hashes.txt
```

## TODO

- [ ] Scope out crates: mlx-rs, rusqlite, sqlite-vec, tokenizers, serde_json
- [ ] Prototype: single-file Rust CLI that embeds stdin text and prints vector
- [ ] Decide on JSONL vs other IPC format (napi shared memory?)
- [ ] Decide if also ship as napi addon or CLI-only
- [ ] Write detailed plan with module breakdown
