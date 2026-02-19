/**
 * Semantic Code Search Extension
 *
 * Natural-language code search using CodeRankEmbed (MLX Metal GPU) + sqlite-vec.
 * All embedding and vector search runs in a native Rust addon via napi-rs.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { resolve, join, relative } from "node:path";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

import { NativeBackend } from "./native-backend.js";
import { indexDirectory, type IndexStats } from "./indexer.js";

const CACHE_DIR = ".code-search-cache";
const DB_FILE = "index.db";

let backend: NativeBackend | null = null;
/** Set of repo roots we've already opened a DB for */
const openedDbs = new Set<string>();

function ensureBackend(): NativeBackend {
  if (!backend) {
    backend = new NativeBackend();
  }
  return backend;
}

function findRepoRoot(dir: string): string {
  try {
    return execSync("git rev-parse --show-toplevel", { cwd: dir, encoding: "utf-8" }).trim();
  } catch {
    return dir;
  }
}

function ensureDb(repoRoot: string): void {
  const b = ensureBackend();
  if (!openedDbs.has(repoRoot)) {
    const dbPath = join(repoRoot, CACHE_DIR, DB_FILE);
    b.openDb(dbPath);
    openedDbs.add(repoRoot);
  }
}

export default function (pi: ExtensionAPI) {
  // ── semantic_search tool ─────────────────────────────────────────────

  const SearchParams = Type.Object({
    query: Type.Union([
      Type.String({ description: "Natural language search query" }),
      Type.Array(Type.String(), {
        description: "Multiple queries — results are merged and deduplicated, keeping the best score per symbol",
      }),
    ], {
      description: "Search query or queries, e.g. 'rate limiting middleware' or ['rate limiting', 'request throttling']",
    }),
    path: Type.Optional(
      Type.String({ description: "Directory to search (default: current working directory)" }),
    ),
    top_k: Type.Optional(Type.Number({ description: "Number of results to return (default: 25)" })),
    threshold: Type.Optional(Type.Number({ description: "Minimum similarity score 0-1 (default: 0.0)" })),
    language: Type.Optional(Type.String({ description: 'Filter by language, e.g. "go", "typescript"' })),
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

      const repoRoot = findRepoRoot(targetDir);
      const pathPrefix = repoRoot !== targetDir ? relative(repoRoot, targetDir) : undefined;

      const searchStart = performance.now();

      const mkDetails = (overrides: Partial<SearchDetails> = {}): SearchDetails => ({
        query: queryLabel, path: rawPath, resultCount: 0, searchTimeMs: 0, ...overrides,
      });

      // Initialize native backend
      let b: NativeBackend;
      try {
        b = ensureBackend();
        ensureDb(repoRoot);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to initialize native backend: ${message}` }],
          isError: true,
          details: mkDetails({ isError: true }),
        };
      }

      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled" }], details: mkDetails() };
      }

      // Incremental index update
      let indexStats: IndexStats | undefined;
      try {
        indexStats = await indexDirectory(targetDir, repoRoot, b, signal, (msg) => {
          onUpdate?.({ content: [{ type: "text", text: msg }], details: mkDetails() });
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Indexing failed: ${message}` }],
          isError: true,
          details: mkDetails({ isError: true }),
        };
      }

      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled" }], details: mkDetails() };
      }

      // Search — single FFI call: batch embed queries + vector search + dedup
      try {
        const results = b.search(queries, topK, threshold, params.language, params.kind, pathPrefix);

        const searchTimeMs = Math.round(performance.now() - searchStart);

        if (results.length === 0) {
          const stats = b.getStats();
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

        for (const r of results) {
          const lineRange = r.end_line ? `${r.line}-${r.end_line}` : String(r.line);
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
          details: mkDetails({ resultCount: results.length, indexStats, searchTimeMs }),
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Search failed: ${message}` }],
          isError: true,
          details: mkDetails({ isError: true }),
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
          0, 0,
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
    description: "Force reindex of a directory (default: cwd).",
    handler: async (args, ctx) => {
      const rawPath = args?.trim() || ".";
      const scanDir = resolve(ctx.cwd, rawPath);
      const repoRoot = findRepoRoot(scanDir);

      if (!existsSync(scanDir)) {
        ctx.ui.notify(`Directory not found: ${rawPath}`, "error");
        return;
      }

      ctx.ui.notify(`Reindexing ${rawPath === "." ? "current directory" : rawPath}...`, "info");

      let b: NativeBackend;
      try {
        b = ensureBackend();
        ensureDb(repoRoot);
      } catch (err: unknown) {
        ctx.ui.notify(`Failed to init: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }

      // Delete symbols/files in scope
      const scopePrefix = scanDir === repoRoot ? null : relative(repoRoot, scanDir);
      const allFiles = b.getAllFiles();
      const toDelete = allFiles
        .filter((f) => scopePrefix === null || f.path.startsWith(scopePrefix + "/"))
        .map((f) => f.path);
      b.deleteFiles(toDelete);

      // Rebuild
      const stats = await indexDirectory(scanDir, repoRoot, b, undefined, (msg) => {
        ctx.ui.notify(msg, "info");
      });

      ctx.ui.notify(
        `Reindex complete: ${stats.symbolsIndexed} symbols from ${stats.filesIndexed} files (${stats.indexTimeMs}ms)`,
        "success",
      );
    },
  });

  // ── System prompt ─────────────────────────────────────────────────────

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: event.systemPrompt + `\n\nYou have access to \`semantic_search\` for natural-language code search. Use it when searching by concept ("authentication handling", "rate limiting logic") rather than exact names. Pass multiple queries as an array to cover different phrasings in a single call — e.g. query: ["rate limiting", "request throttling", "quota enforcement"]. Results are merged and deduplicated. For exact identifiers use \`find_identifiers\`, for text patterns use \`string_search\`, for code structure use \`code_nav\`.`,
    };
  });

  // ── Cleanup ───────────────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    if (backend) {
      try { backend.dispose(); } catch { /* ignore */ }
      backend = null;
    }
    openedDbs.clear();
  });
}
