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
  isToolCallEventType,
} from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { resolve, extname, relative, sep } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { execFile } from "node:child_process";

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
  namePattern: Type.Optional(
    Type.String({
      description: "Regex pattern to filter symbols by name (e.g. \"^Get\" or \"Handler$\" or \"usage.*report\"). Already case-insensitive — do NOT use (?i) inline flags.",
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
const MAX_DIR_FILES_FILTERED = 10000;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "code_nav",
    label: "Code Nav",
    description: `Analyze code structure using tree-sitter. Extract symbols (functions, classes, methods, types, etc.) from source files.

For a single file: returns all symbols with line numbers and optional signatures.
For a directory: returns top-level symbols across all supported files (max ${MAX_DIR_FILES} files, or ${MAX_DIR_FILES_FILTERED} when filtering by kind or namePattern).

Use "outline" action (default) for a hierarchical tree view — best for exploring structure, understanding a file or project layout, and navigating to specific code sections.
Use "symbols" action for a flat list — best when filtering by kind (e.g. kind="method") or when you need a compact scannable list of definitions.
Use "namePattern" to filter symbols by regex (e.g. namePattern="Handler$" or namePattern="(?i)usage"). Applies to both actions.
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
        const result = await processDirectory(absPath, ctx.cwd, action, showSigs, signal, params.kind, params.namePattern);
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
          const limit = (params.kind || params.namePattern) ? MAX_DIR_FILES_FILTERED : MAX_DIR_FILES;
          output += `\n\n[Scanned ${result.fileCount} of ${result.fileCount + result.skipped} supported files. ${result.skipped} files skipped (limit: ${limit}). Narrow the path to see more.]`;
        }
      } else {
        try {
          const { tree, language, source } = await parseFile(rawPath, ctx.cwd);

          const opts: ExtractOptions = {
            signatures: showSigs,
            kind: params.kind,
            namePattern: params.namePattern,
          };

          const symbols = extractSymbols(tree, language.grammar, source, opts);

          output =
            action === "outline"
              ? formatOutline(symbols, showSigs)
              : formatSymbols(symbols, showSigs);

          if (!output.trim()) {
            const filters = [params.kind && `kind="${params.kind}"`, params.namePattern && `namePattern="${params.namePattern}"`].filter(Boolean).join(", ");
            output = filters
              ? `No symbols matching ${filters} found in ${rawPath}`
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
      if (args.namePattern) {
        text += theme.fg("dim", ` --name=${args.namePattern}`);
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

  // ── find_identifiers tool ──────────────────────────────────────────────

  const FindIdentifiersParams = Type.Object({
    name: Type.String({ description: "Identifier name to search for (exact match)" }),
    path: Type.String({ description: "File or directory to search in" }),
    context: Type.Optional(
      Type.Number({ description: "Number of lines of context to show before and after each match (default: 0)" })
    ),
  });

  // Node types that represent identifiers across grammars
  const IDENTIFIER_TYPES = new Set([
    // JS/TS
    "identifier", "type_identifier", "property_identifier", "shorthand_property_identifier",
    "shorthand_property_identifier_pattern",
    // Rust
    "field_identifier", "scoped_identifier",
    // Go
    "field_identifier", "package_identifier",
    // Python
    "attribute",
    // General
    "simple_identifier", // Kotlin
    "name", "qualified_name",
    // Ruby
    "constant", "symbol",
  ]);

  interface IdentifierMatch {
    file: string;
    line: number;
    col: number;
    lineText: string;
    nodeType: string;
    parentType: string;
    sourceLines: string[];
  }

  function findIdentifiersInTree(
    tree: ReturnType<typeof import("web-tree-sitter").default.prototype.parse>,
    name: string,
    source: string,
    filePath: string,
  ): IdentifierMatch[] {
    const matches: IdentifierMatch[] = [];
    const sourceLines = source.split("\n");

    function walk(node: { type: string; text: string; startPosition: { row: number; column: number }; parent: any; childCount: number; child: (i: number) => any; isNamed: boolean }) {
      if (IDENTIFIER_TYPES.has(node.type) && node.text === name) {
        const line = node.startPosition.row;
        matches.push({
          file: filePath,
          line: line + 1,
          col: node.startPosition.column + 1,
          lineText: sourceLines[line]?.trimEnd() ?? "",
          nodeType: node.type,
          parentType: node.parent?.type ?? "root",
          sourceLines,
        });
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.isNamed) walk(child);
      }
    }

    walk(tree.rootNode as any);
    return matches;
  }

  pi.registerTool({
    name: "find_identifiers",
    label: "Find Identifiers",
    description: `Find all occurrences of an identifier name in code files using tree-sitter AST parsing. Unlike grep, this only matches actual identifier nodes — it skips strings, comments, and partial matches within other names. Searches a single file or recursively through a directory (max ${MAX_DIR_FILES} files). Not scope-aware: returns all identifiers with the given name regardless of scope.`,
    parameters: FindIdentifiersParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
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
          details: {},
        };
      }

      const allMatches: IdentifierMatch[] = [];

      if (stat.isDirectory()) {
        const supportedExts = new Set(getSupportedExtensions());
        const files = collectFiles(absPath, supportedExts, MAX_DIR_FILES);

        for (const file of files.found) {
          if (signal?.aborted) break;
          try {
            const { tree, source } = await parseFile(file, ctx.cwd);
            const relPath = relative(ctx.cwd, file);
            allMatches.push(...findIdentifiersInTree(tree, params.name, source, relPath));
          } catch {
            // skip unparseable files
          }
        }
      } else {
        try {
          const { tree, source } = await parseFile(absPath, ctx.cwd);
          const relPath = relative(ctx.cwd, absPath);
          allMatches.push(...findIdentifiersInTree(tree, params.name, source, relPath));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: message }],
            isError: true,
            details: {},
          };
        }
      }

      const elapsed = Math.round(performance.now() - start);

      if (allMatches.length === 0) {
        return {
          content: [{ type: "text", text: `No occurrences of "${params.name}" found in ${rawPath}` }],
          details: { name: params.name, path: rawPath, count: 0, timeMs: elapsed },
        };
      }

      // Format output
      const ctx_lines = params.context ?? 0;
      const lines: string[] = [];
      let currentFile = "";
      for (const m of allMatches) {
        if (m.file !== currentFile) {
          if (currentFile) lines.push("");
          lines.push(m.file);
          currentFile = m.file;
        }

        if (ctx_lines > 0) {
          const startLine = Math.max(0, m.line - 1 - ctx_lines);
          const endLine = Math.min(m.sourceLines.length, m.line + ctx_lines);
          if (lines[lines.length - 1] !== m.file) lines.push("  --");
          for (let i = startLine; i < endLine; i++) {
            const lineNum = i + 1;
            const marker = lineNum === m.line ? ">" : " ";
            lines.push(`${marker} ${lineNum}:  ${m.sourceLines[i]?.trimEnd() ?? ""}`);
          }
        } else {
          lines.push(`  ${m.line}:${m.col}  ${m.lineText}`);
        }
      }

      const output = lines.join("\n");
      const truncation = truncateHead(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let resultText = truncation.content;
      if (truncation.truncated) {
        resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`;
      }

      const details = {
        name: params.name,
        path: rawPath,
        count: allMatches.length,
        fileCount: new Set(allMatches.map((m) => m.file)).size,
        timeMs: elapsed,
        truncated: truncation.truncated,
      };

      return {
        content: [{ type: "text", text: resultText }],
        details,
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("find_identifiers "));
      text += theme.fg("accent", `"${args.name}"`);
      text += " " + theme.fg("muted", args.path);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as { count?: number; fileCount?: number; timeMs?: number; truncated?: boolean } | undefined;

      if (result.isError) {
        const errText = result.content[0];
        return new Text(theme.fg("error", errText?.type === "text" ? errText.text : "Error"), 0, 0);
      }

      if (!details || details.count === 0) {
        return new Text(theme.fg("dim", "No matches"), 0, 0);
      }

      let text = theme.fg("success", `${details.count} occurrences`);
      if (details.fileCount && details.fileCount > 1) {
        text += theme.fg("dim", ` across ${details.fileCount} files`);
      }
      if (details.timeMs !== undefined) {
        text += theme.fg("dim", ` ${details.timeMs}ms`);
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

  // ── string_search tool (rg wrapper) ─────────────────────────────────────

  const StringSearchParams = Type.Object({
    pattern: Type.String({ description: "Regex pattern to search for (Rust regex syntax)" }),
    path: Type.String({ description: "File or directory to search in" }),
    fixedStrings: Type.Optional(
      Type.Boolean({ description: "Treat pattern as a literal string, not a regex (default: false)" }),
    ),
    caseSensitive: Type.Optional(
      Type.Boolean({ description: "Force case-sensitive search (default: smart-case — case-insensitive unless pattern has uppercase)" }),
    ),
    include: Type.Optional(
      Type.Array(Type.String(), { description: 'Glob patterns to include, e.g. ["*.go", "*.ts"]' }),
    ),
    exclude: Type.Optional(
      Type.Array(Type.String(), { description: 'Glob patterns to exclude, e.g. ["*_test.go", "vendor/**"]' }),
    ),
    context: Type.Optional(
      Type.Number({ description: "Lines of context to show around each match (default: 0)" }),
    ),
    maxResults: Type.Optional(
      Type.Number({ description: "Maximum number of matching lines to return (default: 500)" }),
    ),
  });

  pi.registerTool({
    name: "string_search",
    label: "String Search",
    description: `Search for text patterns in files using ripgrep. Returns matching lines with file paths and line numbers. Searches recursively by default, respects .gitignore, and skips binary files.

Use this for literal text searches: config values, error messages, TODOs, log strings, identifiers in non-code files, etc.
For code structure (finding functions, classes, types, etc.), use \`code_nav\` instead.
For finding all occurrences of an identifier in code, use \`find_identifiers\` instead.

Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    parameters: StringSearchParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const rawPath = params.path.replace(/^@/, "");
      const absPath = resolve(ctx.cwd, rawPath);

      const args: string[] = [
        "--line-number",
        "--no-heading",
        "--color", "never",
      ];

      if (params.fixedStrings) args.push("--fixed-strings");
      if (params.caseSensitive) args.push("--case-sensitive");
      if (params.context && params.context > 0) args.push("-C", String(params.context));

      const maxResults = params.maxResults ?? 500;
      args.push("--max-count", String(maxResults));

      if (params.include) {
        for (const glob of params.include) {
          args.push("--glob", glob);
        }
      }
      if (params.exclude) {
        for (const glob of params.exclude) {
          args.push("--glob", `!${glob}`);
        }
      }

      args.push("--", params.pattern, absPath);

      return new Promise((resolvePromise) => {
        const child = execFile("rg", args, {
          maxBuffer: 10 * 1024 * 1024,
          cwd: ctx.cwd,
          signal: signal ?? undefined,
        }, (err, stdout, stderr) => {
          // rg exits 1 for "no matches" — not an error
          if (err && (err as any).code !== 1 && !signal?.aborted) {
            resolvePromise({
              content: [{ type: "text", text: stderr || err.message }],
              isError: true,
              details: {},
            });
            return;
          }

          if (!stdout.trim()) {
            resolvePromise({
              content: [{ type: "text", text: `No matches for "${params.pattern}" in ${rawPath}` }],
              details: { pattern: params.pattern, path: rawPath, matchCount: 0 },
            });
            return;
          }

          // Make paths relative to cwd
          let output = stdout;
          const cwdPrefix = ctx.cwd.endsWith(sep) ? ctx.cwd : ctx.cwd + sep;
          if (output.includes(cwdPrefix)) {
            output = output.split(cwdPrefix).join("");
          }

          const matchCount = output.split("\n").filter((l) => l.trim() && !l.startsWith("--")).length;

          const truncation = truncateHead(output, {
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
          });

          let resultText = truncation.content;
          if (truncation.truncated) {
            resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`;
          }

          resolvePromise({
            content: [{ type: "text", text: resultText }],
            details: {
              pattern: params.pattern,
              path: rawPath,
              matchCount,
              truncated: truncation.truncated,
            },
          });
        });
      });
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("string_search "));
      text += theme.fg("accent", `"${args.pattern}"`);
      text += " " + theme.fg("muted", args.path);
      if (args.include) text += theme.fg("dim", ` include=${args.include.join(",")}`);
      if (args.exclude) text += theme.fg("dim", ` exclude=${args.exclude.join(",")}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as { matchCount?: number; truncated?: boolean } | undefined;

      if (result.isError) {
        const errText = result.content[0];
        return new Text(theme.fg("error", errText?.type === "text" ? errText.text : "Error"), 0, 0);
      }

      if (!details || details.matchCount === 0) {
        return new Text(theme.fg("dim", "No matches"), 0, 0);
      }

      let text = theme.fg("success", `${details.matchCount} matches`);
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

  // ── System prompt & grep/rg blocking ───────────────────────────────────

  pi.on("before_agent_start", async (event) => {
    const instruction = `\n\n**IMPORTANT: ALWAYS use \`code_nav\` as the FIRST tool for exploring code structure** (finding symbols, types, interfaces, functions, classes, enums, methods, etc.). For single files, \`code_nav\` shows all nested symbols. For directories, it shows top-level symbols — if you need inner/nested symbols, call \`code_nav\` on the specific file. Use \`find_identifiers\` to find all occurrences of a name across files (like find-references but not scope-aware — skips strings and comments, exact identifier match only). \`grep\` and \`rg\` are NOT available in bash — use the \`string_search\` tool for text/pattern searches (config values, error strings, TODOs, etc.). Use \`code_nav\` for structure, \`find_identifiers\` for usage search, \`string_search\` for text pattern searches, and \`read\` for file contents.`;
    return {
      systemPrompt: event.systemPrompt + instruction,
    };
  });

  // Unconditionally block grep/rg in bash — use string_search tool instead
  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("bash", event)) return;

    const cmd = event.input.command;
    if (!cmd) return;

    // Quick check: does the command contain grep or rg?
    if (!/(^|\||\;|\&|\()\s*(grep|rg|ripgrep)\b/.test(cmd) &&
        !/\b(grep|rg|ripgrep)\s/.test(cmd)) {
      return;
    }

    return {
      block: true,
      reason:
        `BLOCKED: grep/rg are not available in bash. Use the \`string_search\` tool for text pattern searches, ` +
        `\`code_nav\` for code structure, or \`find_identifiers\` for identifier usage.`,
    };
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
  kind?: string,
  namePattern?: string,
): Promise<DirResult> {
  const supportedExts = new Set(getSupportedExtensions());
  const hasFilter = !!(kind || namePattern);
  const fileLimit = hasFilter ? MAX_DIR_FILES_FILTERED : MAX_DIR_FILES;
  const files = collectFiles(absDir, supportedExts, fileLimit);

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
        kind,
        namePattern,
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
