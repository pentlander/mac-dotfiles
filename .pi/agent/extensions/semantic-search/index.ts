/**
 * Semantic Code Search Extension
 *
 * Provides a `semantic_search` tool for natural-language code search using
 * CodeRankEmbed embeddings + sqlite-vec for vector KNN.
 *
 * Usage:
 *   Place in ~/.pi/agent/extensions/semantic-search/
 *   Run `npm install` in this directory.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { resolve, join, relative } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

import { SearchDB, type SearchResult } from "./db.js";
import { Embedder } from "./embedder.js";
import { indexDirectory, type IndexStats } from "./indexer.js";

const CACHE_DIR = ".code-search-cache";
const DB_FILE = "index.db";

/** Per-directory state: DB + warm status */
const indexCache = new Map<string, { db: SearchDB; lastStats: IndexStats | null }>();

/** Shared embedder (one model instance across all directories) */
const embedder = new Embedder();
let embedderReady = false;

async function ensureEmbedder(onProgress?: (msg: string) => void): Promise<void> {
  if (embedderReady) return;

  if (!embedder.isModelDownloaded()) {
    await embedder.downloadModel(onProgress);
  }

  await embedder.init();
  embedderReady = true;
}

/** Find the git repo root for a directory, or return the directory itself. */
function findRepoRoot(dir: string): string {
  try {
    return execSync("git rev-parse --show-toplevel", { cwd: dir, encoding: "utf-8" }).trim();
  } catch {
    return dir;
  }
}

function getOrCreateDB(dir: string): SearchDB {
  const cached = indexCache.get(dir);
  if (cached) return cached.db;

  const dbPath = join(dir, CACHE_DIR, DB_FILE);
  const db = new SearchDB(dbPath);
  indexCache.set(dir, { db, lastStats: null });
  return db;
}

export default function (pi: ExtensionAPI) {
  // ── semantic_search tool ─────────────────────────────────────────────

  const SearchParams = Type.Object({
    query: Type.Union([
      Type.String({ description: "Natural language search query" }),
      Type.Array(Type.String(), { description: "Multiple queries — results are merged and deduplicated, keeping the best score per symbol" }),
    ], { description: "Search query or queries, e.g. 'rate limiting middleware' or ['rate limiting', 'request throttling']" }),
    path: Type.Optional(
      Type.String({ description: "Directory to search (default: current working directory)" }),
    ),
    top_k: Type.Optional(
      Type.Number({ description: "Number of results to return (default: 25)" }),
    ),
    threshold: Type.Optional(
      Type.Number({ description: "Minimum similarity score 0-1 (default: 0.0)" }),
    ),
    language: Type.Optional(
      Type.String({ description: 'Filter by language, e.g. "go", "typescript"' }),
    ),
    kind: Type.Optional(
      Type.String({ description: 'Filter by symbol kind, e.g. "function", "struct", "interface"' }),
    ),
  });

  interface SearchDetails {
    query: string;
    path: string;
    resultCount: number;
    indexStats?: IndexStats;
    searchTimeMs: number;
    isError?: boolean;
  }

  pi.registerTool({
    name: "semantic_search",
    label: "Semantic Search",
    description: `Search code semantically using natural language. Finds functions, types, and symbols by meaning rather than exact name matching. Uses CodeRankEmbed embeddings + sqlite-vec for vector KNN search.

Use this when you need to find code by concept ("where do we handle authentication", "rate limiting logic", "database connection setup") rather than by exact identifier name.

For exact identifier search, use \`find_identifiers\` instead.
For regex text search, use \`string_search\` instead.
For code structure exploration, use \`code_nav\` instead.

First query on a new directory triggers indexing (~1-15s depending on repo size). Subsequent queries use incremental updates (<1s).`,
    parameters: SearchParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const rawPath = (params.path ?? ".").replace(/^@/, "");
      const targetDir = resolve(ctx.cwd, rawPath);
      const topK = params.top_k ?? 25;
      const threshold = params.threshold ?? 0.0;
      const queries = Array.isArray(params.query) ? params.query : [params.query];
      const queryLabel = queries.length === 1 ? queries[0] : `${queries.length} queries`;

      if (!existsSync(targetDir)) {
        return {
          content: [{ type: "text", text: `Directory not found: ${rawPath}` }],
          isError: true,
          details: { query: queryLabel, path: rawPath, resultCount: 0, searchTimeMs: 0, isError: true } as SearchDetails,
        };
      }

      // Always index at the repo root; use path as a post-filter prefix
      const repoRoot = findRepoRoot(targetDir);
      const pathPrefix = repoRoot !== targetDir
        ? relative(repoRoot, targetDir)
        : null; // no filtering when searching from repo root

      const searchStart = performance.now();

      const mkDetails = (overrides: Partial<SearchDetails> = {}): SearchDetails => ({
        query: queryLabel, path: rawPath, resultCount: 0, searchTimeMs: 0, ...overrides,
      });

      // Ensure model is ready
      try {
        await ensureEmbedder((msg) => {
          onUpdate?.({ content: [{ type: "text", text: msg }], details: mkDetails() });
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to load embedding model: ${message}` }],
          isError: true, details: mkDetails({ isError: true }),
        };
      }

      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled" }], details: mkDetails() };
      }

      // Get or create index (always at repo root)
      const db = getOrCreateDB(repoRoot);

      // Incremental index update
      let indexStats: IndexStats | undefined;
      try {
        indexStats = await indexDirectory(targetDir, repoRoot, db, embedder, signal, (msg) => {
          onUpdate?.({ content: [{ type: "text", text: msg }], details: mkDetails() });
        });
        const entry = indexCache.get(repoRoot);
        if (entry) entry.lastStats = indexStats;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Indexing failed: ${message}` }],
          isError: true, details: mkDetails({ isError: true }),
        };
      }

      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled" }], details: mkDetails() };
      }

      // Embed queries and search — multi-query with dedup
      try {
        // Fetch more per-query so we have enough after dedup
        const perQueryK = queries.length > 1 ? Math.ceil(topK * 1.5) : topK;

        // Run all queries and merge results, keeping best score per symbol
        const bestByKey = new Map<string, SearchResult>();

        for (const q of queries) {
          const qEmb = await embedder.embedQuery(q);
          const results = db.search(qEmb, perQueryK, params.language, params.kind, pathPrefix ?? undefined);

          for (const r of results) {
            const key = `${r.file_path}:${r.line}:${r.name}`;
            const existing = bestByKey.get(key);
            if (!existing || r.score > existing.score) {
              bestByKey.set(key, r);
            }
          }
        }

        // Sort by best score, filter by threshold, take top_k
        const merged = [...bestByKey.values()]
          .filter((r) => r.score >= threshold)
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);

        const searchTimeMs = Math.round(performance.now() - searchStart);

        if (merged.length === 0) {
          const stats = db.getStats();
          return {
            content: [{
              type: "text",
              text: `No results for "${queryLabel}" (searched ${stats.symbolCount} symbols across ${stats.fileCount} files)`,
            }],
            details: mkDetails({ indexStats, searchTimeMs }),
          };
        }

        // Format results
        const lines: string[] = [];
        const indexInfo = indexStats && indexStats.filesIndexed > 0
          ? `${indexStats.indexTimeMs}ms index, `
          : "";
        const queryStr = queries.length === 1
          ? `"${queries[0]}"`
          : queries.map((q) => `"${q}"`).join(", ");
        lines.push(
          `Results for ${queryStr} (${indexInfo}${searchTimeMs - (indexStats?.indexTimeMs ?? 0)}ms search):\n`,
        );
        lines.push(`${"Score".padEnd(7)} ${"File".padEnd(50)} Symbol`);

        for (const r of merged) {
          const lineRange = r.end_line ? `${r.line}-${r.end_line}` : String(r.line);
          // file_path is relative to repo root; make it relative to cwd for display
          const absPath = join(repoRoot, r.file_path);
          const displayPath = relative(ctx.cwd, absPath);
          const fileStr = `${displayPath}:${lineRange}`;
          const sigStr = r.signature ?? r.name;
          lines.push(`${r.score.toFixed(2).padEnd(7)} ${fileStr.padEnd(50)} ${sigStr}`);
        }

        const output = lines.join("\n");
        const truncation = truncateHead(output, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });

        let resultText = truncation.content;
        if (truncation.truncated) resultText += `\n\n[Output truncated]`;

        return {
          content: [{ type: "text", text: resultText }],
          details: mkDetails({ resultCount: merged.length, indexStats, searchTimeMs }),
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Search failed: ${message}` }],
          isError: true, details: mkDetails({ isError: true }),
        };
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("semantic_search "));
      const queries = Array.isArray(args.query) ? args.query : [args.query];
      text += theme.fg("accent", queries.map((q: string) => `"${q}"`).join(", "));
      if (args.path) text += " " + theme.fg("muted", args.path);
      if (args.language) text += theme.fg("dim", ` --lang=${args.language}`);
      if (args.kind) text += theme.fg("dim", ` --kind=${args.kind}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as SearchDetails | undefined;

      if (isPartial) {
        const content = result.content[0];
        const msg = content?.type === "text" ? content.text : "Indexing...";
        return new Text(theme.fg("warning", msg), 0, 0);
      }

      if (result.isError || details?.isError) {
        const errText = result.content[0];
        return new Text(
          theme.fg("error", errText?.type === "text" ? errText.text : "Error"),
          0,
          0,
        );
      }

      if (!details || details.resultCount === 0) {
        return new Text(theme.fg("dim", "No results"), 0, 0);
      }

      let text = theme.fg("success", `${details.resultCount} results`);
      text += theme.fg("dim", ` ${details.searchTimeMs}ms`);

      if (details.indexStats && details.indexStats.filesIndexed > 0) {
        text += theme.fg("dim", ` (indexed ${details.indexStats.filesIndexed} files, ${details.indexStats.symbolsIndexed} symbols)`);
      }

      if (expanded) {
        const content = result.content[0];
        if (content?.type === "text") {
          const lines = content.text.split("\n").slice(0, 30);
          for (const line of lines) {
            text += "\n" + theme.fg("dim", line);
          }
          const totalLines = content.text.split("\n").length;
          if (totalLines > 30) {
            text += `\n${theme.fg("muted", `... ${totalLines - 30} more lines`)}`;
          }
        }
      }

      return new Text(text, 0, 0);
    },
  });

  // ── /reindex command ──────────────────────────────────────────────────

  pi.registerCommand("reindex", {
    description: "Force reindex of a directory (default: cwd). Deletes cached entries for the scope and re-indexes.",
    handler: async (args, ctx) => {
      const rawPath = args?.trim() || ".";
      const scanDir = resolve(ctx.cwd, rawPath);
      const repoRoot = findRepoRoot(scanDir);

      if (!existsSync(scanDir)) {
        ctx.ui.notify(`Directory not found: ${rawPath}`, "error");
        return;
      }

      ctx.ui.notify(`Reindexing ${rawPath === "." ? "current directory" : rawPath}...`, "info");

      try {
        await ensureEmbedder((msg) => {
          ctx.ui.notify(msg, "info");
        });
      } catch (err: unknown) {
        ctx.ui.notify(`Failed to load model: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }

      // Delete symbols/files in the scope being reindexed
      const db = getOrCreateDB(repoRoot);
      const scopePrefix = scanDir === repoRoot ? null : relative(repoRoot, scanDir);
      const allFiles = db.getAllFiles();
      db.transaction(() => {
        for (const f of allFiles) {
          if (scopePrefix === null || f.path.startsWith(scopePrefix + "/")) {
            db.deleteFileAndSymbols(f.path);
          }
        }
      });

      // Rebuild
      const stats = await indexDirectory(scanDir, repoRoot, db, embedder, undefined, (msg) => {
        ctx.ui.notify(msg, "info");
      });

      ctx.ui.notify(
        `Reindex complete: ${stats.symbolsIndexed} symbols from ${stats.filesIndexed} files (${stats.indexTimeMs}ms)`,
        "success",
      );
    },
  });

  // ── System prompt injection ───────────────────────────────────────────

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: event.systemPrompt + `\n\nYou have access to \`semantic_search\` for natural-language code search. Use it when searching by concept ("authentication handling", "rate limiting logic") rather than exact names. Pass multiple queries as an array to cover different phrasings in a single call — e.g. query: ["rate limiting", "request throttling", "quota enforcement"]. Results are merged and deduplicated. For exact identifiers use \`find_identifiers\`, for text patterns use \`string_search\`, for code structure use \`code_nav\`.`,
    };
  });

  // ── Cleanup ───────────────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    for (const [, entry] of indexCache) {
      try {
        entry.db.close();
      } catch {
        // ignore
      }
    }
    indexCache.clear();

    try {
      await embedder.dispose();
    } catch {
      // ignore
    }
    embedderReady = false;
  });
}
