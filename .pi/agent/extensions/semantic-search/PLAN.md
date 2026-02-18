# Semantic Code Search — Pi Extension Plan

## Overview

A pi extension that provides a `semantic_search` tool for natural-language code search. The agent can query "where do we handle rate limiting" and get back ranked results from the codebase, without needing to know exact function/variable names.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  pi extension (semantic-search/index.ts)        │
│                                                 │
│  Registers:                                     │
│    • semantic_search tool (query, path, top_k)  │
│    • /reindex command (force rebuild)           │
│    • session_start → warm index if cached       │
│    • session_shutdown → cleanup                 │
│                                                 │
│  Internal modules:                              │
│    • indexer.ts — file walking, hashing, update │
│    • embedder.ts — ONNX model inference         │
│    • db.ts — SQLite + sqlite-vec schema/queries │
│    • chunker.ts — tree-sitter → embedding text  │
└─────────────────────────────────────────────────┘
```

## Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Embedding model | CodeRankEmbed quantized (int8) | 138MB ONNX, 768-dim, code-specific, MIT license |
| ONNX runtime | `onnxruntime-node` with Metal EP | ~3-5x faster than WASM; Apple Silicon GPU acceleration |
| Chunking | tree-sitter (reuse grammars from tree-sitter-nav) | Code-aware, extracts semantic units |
| Storage + search | `better-sqlite3` + `sqlite-vec` | Single-file DB; KNN via `vec0` virtual table with cosine distance; SQL metadata filtering |
| File hashing | `xxhash-wasm` | Fast content hashing for incremental updates |
| Cache location | `.code-search-cache/index.db` in target repo root | Per-repo index, gitignored |

## Embedding Strategy

### What gets embedded

Each symbol produces one embedding from a string like:

```
go | controller/router/assignment.go | func buildDeploymentAssignmentAudit(ctx context.Context, assignment *DeploymentAssignment, stacklet *Stacklet) *AssignmentAudit
```

Format: `<lang> | <relative-path> | <signature-with-types>`

Components:
- **Language tag** — disambiguates cross-language patterns
- **Relative path** — encodes domain context (e.g. `customer/invoice` signals billing)
- **Signature** — function/method name + parameter types + return type

### What does NOT get embedded

- Function bodies — adds noise, dilutes the embedding
- Comments/docstrings — could add later as an enhancement, but signatures + paths carry most signal
- Generated code (`.pb.go`, `.pb.gw.go`, `_generated.go`, `node_modules/`) — skip via exclude patterns
- Test files — optional, configurable

### Symbol extraction

Reuse `parseFile()` and `extractSymbols()` from the tree-sitter-nav extension. Extract:
- Functions / methods (with signatures enabled)
- Types / structs / interfaces / classes
- Constants / enums (top-level only)

For each symbol, build the embedding string from path + signature.

## Storage

### SQLite + sqlite-vec schema (`.code-search-cache/index.db`)

```sql
-- sqlite-vec loaded via: sqliteVec.load(db)

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Stores: model_name, model_version, dimensions, created_at, updated_at

CREATE TABLE files (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  language TEXT,
  symbol_count INTEGER,
  indexed_at INTEGER NOT NULL
);

-- Single vec0 table with metadata + auxiliary columns — no JOIN needed
CREATE VIRTUAL TABLE vec_symbols USING vec0(
  -- Vector column
  embedding float[768] distance_metric=cosine,

  -- Metadata columns: filterable in WHERE during KNN
  language text,
  kind text,

  -- Auxiliary columns: returned in SELECT, not filterable in KNN WHERE
  +file_path text,
  +name text,
  +line integer,
  +end_line integer,
  +signature text,
  +embedding_text text
);
```

**Single-table design using vec0 column types:**
- **Metadata columns** (`language`, `kind`) — stored inline with vectors, can filter during KNN search (e.g. `AND language = 'go' AND kind = 'function'`). Good for low-cardinality, short strings.
- **Auxiliary columns** (`file_path`, `name`, `line`, etc.) — stored in a separate internal table, returned in `SELECT` results without needing an external JOIN. Cannot appear in KNN `WHERE`. Good for result payload.
- **No partition keys** — partition keys need ~100+ vectors per unique value. Neither `language` (some have <100 symbols) nor `file_path` (one per file) are suitable. At 50K vectors, brute-force scan is fast enough.

The `files` table remains separate for incremental indexing (hash tracking). Symbols are stored entirely in `vec_symbols`.

### Why this works

- **KNN + metadata filter + result payload in one query, no JOIN:**
  ```sql
  SELECT rowid, distance, file_path, name, kind, line, end_line, signature
  FROM vec_symbols
  WHERE embedding MATCH ?
    AND k = 10
    AND language = 'go'
    AND kind = 'function'
  ```
- **Incremental updates** — `DELETE FROM vec_symbols WHERE rowid IN (SELECT rowid FROM vec_symbols WHERE file_path = ?)` then insert new rows
- **No in-memory matrix** — sqlite-vec manages vector storage internally
- **Single file** — `.code-search-cache/index.db`, easy to nuke and rebuild
- **sqlite-vec is tiny** — 162KB native extension, pure C, no dependencies

### Inserting

```typescript
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const db = new Database(".code-search-cache/index.db");
sqliteVec.load(db);

const insert = db.prepare(`
  INSERT INTO vec_symbols (embedding, language, kind, file_path, name, line, end_line, signature, embedding_text)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const embedding = new Float32Array([...]); // 768-dim from model
insert.run(embedding, "go", "function", "controller/router/assignment.go",
           "buildDeploymentAssignmentAudit", 675, 750,
           "func buildDeploymentAssignmentAudit(...) *AssignmentAudit",
           "go | controller/router/assignment.go | func buildDeploymentAssignmentAudit(...)");
```

### Querying

```typescript
const queryEmbedding = new Float32Array([...]); // embed("rate limiting middleware")

const results = db.prepare(`
  SELECT file_path, name, kind, line, end_line, signature,
         (1 - distance) as score
  FROM vec_symbols
  WHERE embedding MATCH ?
    AND k = ?
`).all(queryEmbedding, topK);
```

With language/kind filters:
```typescript
const results = db.prepare(`
  SELECT file_path, name, kind, line, end_line, signature,
         (1 - distance) as score
  FROM vec_symbols
  WHERE embedding MATCH ?
    AND k = ?
    AND language = ?
    AND kind = 'function'
`).all(queryEmbedding, topK, "go");
```

Note: `vec0` with `distance_metric=cosine` returns cosine *distance* (0 = identical, 2 = opposite). Convert to similarity: `score = 1 - distance`.

### Deleting symbols for a changed/removed file

```typescript
// vec0 doesn't support subqueries in DELETE, so two-step:
const getRowids = db.prepare(
  `SELECT rowid FROM vec_symbols WHERE file_path = ?`
);
const deleteRow = db.prepare(
  `DELETE FROM vec_symbols WHERE rowid = ?`
);

db.transaction((filePath: string) => {
  for (const row of getRowids.all(filePath)) {
    deleteRow.run(row.rowid);
  }
  db.prepare(`DELETE FROM files WHERE path = ?`).run(filePath);
})(filePath);
```

Note: auxiliary columns CAN be used in regular `SELECT ... WHERE` (outside of KNN), just not in the `WHERE` of a `MATCH` KNN query. So `WHERE file_path = ?` works for deletion.

## Indexing

### Incremental update flow

On each query (or explicit `/reindex`):

1. Walk repo file tree (respect `.gitignore` via `ignore` npm package)
2. Filter to supported extensions, skip excluded patterns
3. Hash each file with xxhash
4. Compare against `files` table:
   - **Unchanged** (hash matches) → skip
   - **Changed** (hash differs) → delete old vec_symbols rows for file, re-parse, re-extract, re-embed, insert
   - **Deleted** (in DB but not on disk) → delete vec_symbols rows + files row
   - **New** (on disk but not in DB) → parse, extract, embed, insert
5. Wrap all mutations in a single transaction
6. No matrix invalidation needed — sqlite-vec handles it



### Cold start performance estimate

For a small Go project (~200 files, ~500 symbols):
- Tree-sitter parse: ~200ms total
- Embedding (500 chunks × ~2ms each with Metal): ~1s
- File hashing: ~50ms
- Total: ~1.5s

For a medium TS project (~800 files, ~5000 symbols):
- Tree-sitter parse: ~2s
- Embedding (5000 chunks × ~2ms each): ~10s
- File hashing: ~200ms
- Total: ~12s

Subsequent queries with few changes: <500ms (hash check + embed changed + search).

## Tool Interface

### `semantic_search` tool

```typescript
parameters: {
  query: string,          // Natural language query, e.g. "rate limiting middleware"
  path?: string,          // Directory to search (default: cwd)
  top_k?: number,         // Number of results (default: 10)
  threshold?: number,     // Minimum similarity score (default: 0.3)
  include?: string[],     // File glob filters, e.g. ["*.go"]
  exclude?: string[],     // Exclude globs, e.g. ["*_test.go"]
}
```

### Output format

```
Results for "rate limiting middleware" (12s index, 3ms search):

Score  File                                    Symbol
0.87   middleware/rate_limit.go:15-45          func RateLimitMiddleware(config RateLimitConfig) Middleware
0.82   middleware/abuse.go:23-67               func AbuseMiddleware(limiter *RateLimiter) Middleware
0.76   controller/limits.go:8-34              func NewRateLimiter(cfg Config) *RateLimiter
0.71   handlers/tcp_listener/main.go:112-140  func (h *Handler) applyRateLimit(conn net.Conn) error
0.65   gateways/network_cp/main.go:89-115     type RateLimitPolicy struct { ... }
```

### `/reindex` command

Force a full rebuild of the index for the current working directory. Useful after large refactors or branch switches.

```
/reindex              # Reindex cwd
/reindex ~/projects/myrepo  # Reindex specific path
```

## File Structure

```
~/.pi/agent/extensions/semantic-search/
├── package.json          # Dependencies
├── index.ts              # Extension entry point (tool + command + events)
├── indexer.ts            # File walking, hashing, incremental update logic
├── embedder.ts           # ONNX model loading + inference
├── db.ts                 # SQLite + sqlite-vec schema, prepared statements, queries
├── chunker.ts            # Tree-sitter symbol extraction → embedding strings
└── PLAN.md               # This file
```

### package.json dependencies

```json
{
  "dependencies": {
    "onnxruntime-node": "^1.17.0",
    "better-sqlite3": "^11.0.0",
    "sqlite-vec": "^0.1.7-alpha.2",
    "xxhash-wasm": "^1.0.0",
    "ignore": "^5.3.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0"
  }
}
```

Note: tree-sitter grammars and `web-tree-sitter` are already available from the sibling `tree-sitter-nav` extension. Import `parseFile` and `extractSymbols` from there.

## Phases

### Phase 1: Core search

- [ ] `embedder.ts` — Load CodeRankEmbed ONNX, expose `embed(texts: string[]): Float32Array[]`
- [ ] `chunker.ts` — Extract symbols via tree-sitter, format embedding strings
- [ ] `db.ts` — SQLite + sqlite-vec schema, prepared statements, KNN query
- [ ] `indexer.ts` — File walking, hashing, incremental update orchestration
- [ ] `index.ts` — Register `semantic_search` tool and `/reindex` command
- [ ] Model auto-download on first use (from HuggingFace, with progress notification)
- [ ] `.gitignore` for `.code-search-cache/`

### Phase 2: Polish

- [ ] Status widget showing index state ("Indexed 523 symbols from 87 files")
- [ ] Background re-indexing (don't block queries while updating)
- [ ] Configurable exclude patterns (default: skip `*_test.go`, `*.pb.go`, `node_modules/`, `vendor/`)
- [ ] System prompt injection: tell the agent when to use `semantic_search` vs `code_nav` vs `find_identifiers`

### Phase 3: Enhancements (future)

- [ ] Hybrid search: combine semantic scores with BM25 text matching via `sqlite-vec` scalar functions
- [ ] Include docstrings/comments in embedding text
- [ ] Multi-repo support (index multiple paths, search across all)
- [ ] int8 quantized vectors in sqlite-vec (768 bytes/symbol vs 3072 bytes/symbol)

## Open Questions

1. **Model download UX** — First run downloads ~138MB. Show progress via `ctx.ui.notify` with periodic updates.
2. **Cross-extension imports** — Can we `import { parseFile } from "../tree-sitter-nav/parser.js"`? Need to verify pi's module resolution. Fallback: duplicate the parsing code.
3. **CodeRankEmbed query prefix** — Some embedding models expect `search_query: ` prefix for queries vs `search_document: ` for documents. Need to check CodeRankEmbed's expected format from model card / paper.
4. **Index location** — `.code-search-cache/` in repo root vs `~/.cache/semantic-search/<repo-hash>/`? Repo-local is simpler but pollutes the repo (needs .gitignore entry). Global cache avoids pollution but loses locality.
5. **Metal EP availability** — Need to verify `onnxruntime-node` ships Metal EP for macOS ARM64 in the npm package, or if it needs a separate install.
