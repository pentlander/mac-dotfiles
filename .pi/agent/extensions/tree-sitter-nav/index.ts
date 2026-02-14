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

import { parseFile, clearCache } from "./parser.js";
import {
  extractSymbols,
  formatSymbols,
  formatOutline,
  type SymbolInfo,
  type ExtractOptions,
} from "./symbols.js";
import { getLanguageForExtension, getSupportedExtensions, getRgTypeMap } from "./languages.js";
import { parse as parseShell } from "shell-quote";

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

  // Instruct the LLM to prefer code_nav over grep for structural navigation
  pi.on("before_agent_start", async (event) => {
    const instruction = `\n\n**IMPORTANT: ALWAYS use \`code_nav\` as the FIRST tool for exploring code structure** (finding symbols, types, interfaces, functions, classes, enums, methods, etc.). For single files, \`code_nav\` shows all nested symbols. For directories, it shows top-level symbols — if you need inner/nested symbols, call \`code_nav\` on the specific file. Structural grep/rg searches on code files (patterns containing keywords like function, class, def, struct, impl, trait, type, interface, enum, etc.) are BLOCKED and will fail. Use \`code_nav\` for structure, \`read\` for file contents, and \`grep\`/\`rg\` only for literal text searches (config values, error strings, TODOs, etc.).`;
    return {
      systemPrompt: event.systemPrompt + instruction,
    };
  });

  // Intercept bash calls that use grep/rg for structural code navigation
  // on file types we support, and block them with a suggestion to use code_nav.
  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("bash", event)) return;

    const cmd = event.input.command;
    if (!cmd) return;

    const parsed = parseGrepCommand(cmd);
    if (!parsed) return;

    const supportedExts = new Set(getSupportedExtensions());
    const rgTypeMap = getRgTypeMap();

    // Collect targeted file extensions from flags and file arguments
    const targetedExts: string[] = [];

    // From explicit file path arguments
    for (const filePath of parsed.files) {
      const ext = extname(filePath).toLowerCase();
      if (ext && supportedExts.has(ext)) {
        targetedExts.push(ext);
      }
    }

    // From --include=*.ext (grep)
    for (const pattern of parsed.includeGlobs) {
      const m = pattern.match(/\*?(\.\w+)$/);
      if (m && supportedExts.has(m[1].toLowerCase())) {
        targetedExts.push(m[1].toLowerCase());
      }
    }

    // From --type/-t (rg)
    for (const typeName of parsed.typeFilters) {
      const mapped = rgTypeMap[typeName.toLowerCase()];
      if (mapped && supportedExts.has(mapped)) {
        targetedExts.push(mapped);
      }
    }

    // Check if the search pattern contains structural code keywords
    const structuralPatterns = [
      /\b(def|function|func|fn|class|interface|type|struct|enum|trait|impl|module|mod|export|import|pub|private|protected|abstract)\b/,
      /\b(class|interface|type|struct|enum|trait)\s+\w/,
      /\b(def|function|func|fn)\s+\w/,
    ];

    const isStructuralSearch = structuralPatterns.some((p) => p.test(parsed.pattern));

    // Block if targeting supported files AND the pattern is structural,
    // OR if it's a recursive search with structural patterns
    const shouldBlock =
      (targetedExts.length > 0 && isStructuralSearch) ||
      (parsed.isRecursive && isStructuralSearch);

    if (shouldBlock) {
      return {
        block: true,
        reason:
          `BLOCKED: Do NOT use \`${parsed.tool}\` on code files. You MUST use \`code_nav\` instead. ` +
          `This is not a suggestion — grep/rg on code files is disabled. ` +
          `Use code_nav with action="outline" to explore structure, action="symbols" with kind= to filter, ` +
          `or \`read\` to examine specific files. ` +
          `grep/rg is ONLY for non-code files (logs, .txt, .csv, .env, etc.) or piped output.`,
      };
    }
  });

  // Clean up on shutdown
  pi.on("session_shutdown", async () => {
    clearCache();
  });
}

// ─── Grep/rg command parsing ─────────────────────────────────────────────

/** Flags that consume the next argument as a value (not a file path). */
const GREP_VALUE_FLAGS = new Set([
  // grep
  "-e", "-f", "-m", "--max-count", "-A", "--after-context",
  "-B", "--before-context", "-C", "--context", "--label",
  "--color", "--colour", "--include", "--exclude", "--exclude-dir",
  // rg
  "-t", "--type", "-T", "--type-not", "-g", "--glob", "--iglob",
  "-j", "--threads", "-M", "--max-columns", "--max-filesize",
  "--max-depth", "--maxdepth", "-E", "--encoding",
  "--sort", "--sortr", "--type-add", "--type-clear",
  "--colors", "--context-separator", "--field-match-separator",
  "--path-separator", "-r", "--replace", "--pre", "--pre-glob",
  "--after-context", "--before-context",
]);

interface ParsedGrepCommand {
  tool: "grep" | "rg" | "ripgrep";
  pattern: string;
  files: string[];
  flags: string[];
  includeGlobs: string[];
  typeFilters: string[];
  isRecursive: boolean;
}

/**
 * Parse a shell command string to extract grep/rg invocation details.
 * Returns null if the command doesn't contain a grep/rg call.
 *
 * For pipelines and compound commands, checks each sub-command.
 */
function parseGrepCommand(cmd: string): ParsedGrepCommand | null {
  const tokens = parseShell(cmd);

  // Flatten tokens — shell-quote returns strings, operators ({op: '|'}),
  // and globs ({op: 'glob', pattern: '...'}) for unquoted wildcards.
  const args: string[] = [];
  for (const token of tokens) {
    if (typeof token === "string") {
      args.push(token);
    } else if (typeof token === "object" && token !== null) {
      if ("pattern" in token) {
        // Glob token (e.g. --include=*.py unquoted) — treat as a string arg
        args.push(String(token.pattern));
      } else if ("op" in token) {
        // Pipe, semicolon, &&, || — treat as command boundary
        const result = tryParseGrepArgs(args);
        if (result) return result;
        args.length = 0;
      }
    }
  }

  // Check the last (or only) segment
  return tryParseGrepArgs(args);
}

/** Try to parse an argument list as a grep/rg invocation. */
function tryParseGrepArgs(args: string[]): ParsedGrepCommand | null {
  // Find the grep/rg binary — could be a path like /usr/bin/grep
  const toolIdx = args.findIndex((a) => /^(.*\/)?(grep|rg|ripgrep)$/.test(a));
  if (toolIdx === -1) return null;

  const toolBin = args[toolIdx];
  const tool = toolBin.endsWith("grep") ? "grep" as const
    : toolBin.endsWith("ripgrep") ? "ripgrep" as const
    : "rg" as const;

  const rest = args.slice(toolIdx + 1);

  const flags: string[] = [];
  const files: string[] = [];
  const includeGlobs: string[] = [];
  const typeFilters: string[] = [];
  const explicitPatterns: string[] = [];
  let isRecursive = tool === "rg"; // rg is recursive by default
  let patternConsumed = false;

  let i = 0;
  while (i < rest.length) {
    const arg = rest[i];

    if (arg === "--") {
      // Everything after -- is file paths
      files.push(...rest.slice(i + 1));
      break;
    }

    if (arg.startsWith("-")) {
      flags.push(arg);

      // Check for recursive flags
      if (arg === "-r" || arg === "-R" || arg === "--recursive") {
        isRecursive = true;
      }
      // Short flags can be combined: -rn, -rin, etc.
      if (/^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(arg) && !arg.startsWith("--")) {
        isRecursive = true;
      }

      // Handle --flag=value style
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        const flagName = arg.slice(0, eqIdx);
        const flagValue = arg.slice(eqIdx + 1);

        if (flagName === "--include") {
          includeGlobs.push(flagValue);
        } else if (flagName === "--type" || flagName === "-t") {
          typeFilters.push(flagValue);
        } else if (flagName === "-e" || flagName === "--regexp") {
          explicitPatterns.push(flagValue);
        }
        i++;
        continue;
      }

      // Handle -e / --regexp (explicit pattern, can appear multiple times)
      if (arg === "-e" || arg === "--regexp") {
        if (i + 1 < rest.length) {
          explicitPatterns.push(rest[i + 1]);
          i += 2;
          continue;
        }
      }

      // Handle --include (grep)
      if (arg === "--include") {
        if (i + 1 < rest.length) {
          includeGlobs.push(rest[i + 1]);
          i += 2;
          continue;
        }
      }

      // Handle --type / -t (rg)
      if (arg === "--type" || arg === "-t") {
        if (i + 1 < rest.length) {
          typeFilters.push(rest[i + 1]);
          i += 2;
          continue;
        }
      }

      // Check if this flag consumes the next arg as a value
      if (GREP_VALUE_FLAGS.has(arg)) {
        i += 2; // skip flag + its value
        continue;
      }

      i++;
      continue;
    }

    // Positional argument: first one is the pattern, rest are files
    if (!patternConsumed && explicitPatterns.length === 0) {
      patternConsumed = true;
      explicitPatterns.push(arg);
    } else {
      files.push(arg);
    }
    i++;
  }

  const pattern = explicitPatterns.join(" ");

  return { tool, pattern, files, flags, includeGlobs, typeFilters, isRecursive };
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
