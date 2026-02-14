/**
 * Tree-sitter Code Navigation Extension
 *
 * Provides a `code_nav` tool that uses tree-sitter to extract structural
 * information from source files: symbols, outlines, and signatures.
 *
 * Usage:
 *   Place in ~/.pi/agent/extensions/tree-sitter-nav/
 *   Run `npm install` in this directory.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { resolve, extname, relative, sep } from "node:path";
import { readdirSync, statSync } from "node:fs";

import { parseFile, clearCache } from "./parser.js";
import {
  extractSymbols,
  formatSymbols,
  formatOutline,
  type SymbolInfo,
  type ExtractOptions,
} from "./symbols.js";
import { getLanguageForExtension, getSupportedExtensions } from "./languages.js";

const CodeNavParams = Type.Object({
  path: Type.String({ description: "File or directory path to analyze" }),
  action: Type.Optional(
    StringEnum(["symbols", "outline"] as const, {
      description:
        'Output format: "outline" (default) for a hierarchical tree view — best for understanding file/project structure. "symbols" for a flat list — best when filtering by kind or scanning for specific definitions.',
    }),
  ),
  kind: Type.Optional(
    Type.String({
      description:
        'Filter by symbol kind: "function", "method", "class", "interface", "type", "enum", "struct", "trait", "impl", "module", "variable", "constant", "property", "resource", "data", "block"',
    }),
  ),
  signatures: Type.Optional(
    Type.Boolean({
      description: "Include function/method signatures with parameter types (default: false)",
    }),
  ),
});

interface CodeNavDetails {
  path: string;
  action: string;
  isDirectory: boolean;
  language?: string;
  symbolCount: number;
  fileCount?: number;
  truncated?: boolean;
  parseTimeMs?: number;
}

const MAX_DIR_FILES = 200;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "code_nav",
    label: "Code Nav",
    description: `Analyze code structure using tree-sitter. Extract symbols (functions, classes, methods, types, etc.) from source files.

For a single file: returns all symbols with line numbers and optional signatures.
For a directory: returns top-level symbols across all supported files (max ${MAX_DIR_FILES} files).

Use "outline" action (default) for a hierarchical tree view — best for exploring structure, understanding a file or project layout, and navigating to specific code sections.
Use "symbols" action for a flat list — best when filtering by kind (e.g. kind="method") or when you need a compact scannable list of definitions.
Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.

Supported: TypeScript, JavaScript, Python, Rust, Go, Java, Kotlin, Swift, Ruby, PHP, C#, Scala, Lua, Bash, Zig, Elixir, Dart, OCaml, YAML, TOML, HCL, Terraform.`,
    parameters: CodeNavParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const action = params.action ?? "outline";
      const showSigs = params.signatures ?? false;
      const rawPath = params.path.replace(/^@/, "");
      const absPath = resolve(ctx.cwd, rawPath);

      const start = performance.now();

      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(absPath);
      } catch {
        return {
          content: [{ type: "text", text: `Path not found: ${rawPath}` }],
          isError: true,
          details: { path: rawPath, action, isDirectory: false, symbolCount: 0 } as CodeNavDetails,
        };
      }

      let output: string;
      let details: CodeNavDetails;

      if (stat.isDirectory()) {
        const result = await processDirectory(absPath, ctx.cwd, action, showSigs, signal);
        output = result.output;
        details = {
          path: rawPath,
          action,
          isDirectory: true,
          symbolCount: result.symbolCount,
          fileCount: result.fileCount,
          parseTimeMs: Math.round(performance.now() - start),
        };

        if (result.skipped > 0) {
          output += `\n\n[Scanned ${result.fileCount} of ${result.fileCount + result.skipped} supported files. ${result.skipped} files skipped (limit: ${MAX_DIR_FILES}). Narrow the path to see more.]`;
        }
      } else {
        try {
          const { tree, language, source } = await parseFile(rawPath, ctx.cwd);

          const opts: ExtractOptions = {
            signatures: showSigs,
            kind: params.kind,
          };

          const symbols = extractSymbols(tree, language.grammar, source, opts);

          output =
            action === "outline"
              ? formatOutline(symbols, showSigs)
              : formatSymbols(symbols, showSigs);

          if (!output.trim()) {
            output = params.kind
              ? `No "${params.kind}" symbols found in ${rawPath}`
              : `No symbols found in ${rawPath}`;
          }

          details = {
            path: rawPath,
            action,
            isDirectory: false,
            language: language.name,
            symbolCount: countSymbols(symbols),
            parseTimeMs: Math.round(performance.now() - start),
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: message }],
            isError: true,
            details: {
              path: rawPath,
              action,
              isDirectory: false,
              symbolCount: 0,
            } as CodeNavDetails,
          };
        }
      }

      // Apply truncation
      const truncation = truncateHead(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let resultText = truncation.content;
      if (truncation.truncated) {
        details.truncated = true;
        resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
      }

      return {
        content: [{ type: "text", text: resultText }],
        details,
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("code_nav "));
      const action = args.action ?? "symbols";
      text += theme.fg("accent", action);
      text += " " + theme.fg("muted", args.path);
      if (args.kind) {
        text += theme.fg("dim", ` --kind=${args.kind}`);
      }
      if (args.signatures) {
        text += theme.fg("dim", " --signatures");
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as CodeNavDetails | undefined;

      if (isPartial) {
        return new Text(theme.fg("warning", "Parsing..."), 0, 0);
      }

      if (result.isError) {
        const errText = result.content[0];
        return new Text(
          theme.fg("error", errText?.type === "text" ? errText.text : "Error"),
          0,
          0,
        );
      }

      if (!details) {
        return new Text(theme.fg("dim", "No details"), 0, 0);
      }

      let text = "";
      if (details.isDirectory) {
        text += theme.fg("success", `${details.symbolCount} symbols`);
        text += theme.fg("dim", ` across ${details.fileCount} files`);
      } else {
        text += theme.fg("success", `${details.symbolCount} symbols`);
        if (details.language) {
          text += theme.fg("dim", ` (${details.language})`);
        }
      }

      if (details.parseTimeMs !== undefined) {
        text += theme.fg("dim", ` ${details.parseTimeMs}ms`);
      }

      if (details.truncated) {
        text += " " + theme.fg("warning", "(truncated)");
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

  // Clean up on shutdown
  pi.on("session_shutdown", async () => {
    clearCache();
  });
}

// ─── Directory scanning ─────────────────────────────────────────────────

interface DirResult {
  output: string;
  symbolCount: number;
  fileCount: number;
  skipped: number;
}

async function processDirectory(
  absDir: string,
  cwd: string,
  action: string,
  showSigs: boolean,
  signal?: AbortSignal,
): Promise<DirResult> {
  const supportedExts = new Set(getSupportedExtensions());
  const files = collectFiles(absDir, supportedExts, MAX_DIR_FILES);

  const sections: string[] = [];
  let totalSymbols = 0;

  for (const file of files.found) {
    if (signal?.aborted) break;

    try {
      const relPath = relative(cwd, file);
      const { tree, language, source } = await parseFile(file, cwd);

      const opts: ExtractOptions = {
        signatures: showSigs,
        topLevelOnly: true,
        maxDepth: 2,
      };

      const symbols = extractSymbols(tree, language.grammar, source, opts);
      if (symbols.length === 0) continue;

      totalSymbols += countSymbols(symbols);

      const formatted =
        action === "outline"
          ? formatOutline(symbols, showSigs)
          : formatSymbols(symbols, showSigs);

      sections.push(`── ${relPath} (${language.name}) ──\n${formatted}`);
    } catch {
      // Skip files that fail to parse
    }
  }

  return {
    output: sections.join("\n\n"),
    symbolCount: totalSymbols,
    fileCount: files.found.length,
    skipped: files.skipped,
  };
}

interface CollectResult {
  found: string[];
  skipped: number;
}

function collectFiles(
  dir: string,
  supportedExts: Set<string>,
  maxFiles: number,
): CollectResult {
  const found: string[] = [];
  let skipped = 0;

  function walk(d: string) {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }

    // Sort for deterministic output
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (found.length >= maxFiles) {
        if (entry.isFile() && supportedExts.has(extname(entry.name).toLowerCase())) {
          skipped++;
        }
        continue;
      }

      const fullPath = resolve(d, entry.name);

      // Skip hidden dirs, node_modules, vendor, .git, etc.
      if (entry.isDirectory()) {
        const name = entry.name;
        if (
          name.startsWith(".") ||
          name === "node_modules" ||
          name === "vendor" ||
          name === "__pycache__" ||
          name === "target" ||
          name === "build" ||
          name === "dist" ||
          name === ".git"
        ) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (supportedExts.has(ext)) {
          found.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return { found, skipped };
}

function countSymbols(symbols: SymbolInfo[]): number {
  let count = 0;
  for (const sym of symbols) {
    count++;
    count += countSymbols(sym.children);
  }
  return count;
}
