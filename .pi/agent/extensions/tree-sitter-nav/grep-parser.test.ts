/**
 * Tests for grep/rg command parsing.
 *
 * Run: cd ~/.pi/agent/extensions/tree-sitter-nav && npx tsx grep-parser.test.ts
 */

import { parse as parseShell } from "shell-quote";
import { extname } from "node:path";
import { getSupportedExtensions, getRgTypeMap } from "./languages.js";

// ─── Copy of types and parser from index.ts ─────────────────────────────
// These are duplicated here to test in isolation. If the parser is ever
// extracted to its own module, import from there instead.

const GREP_VALUE_FLAGS = new Set([
  "-e", "-f", "-m", "--max-count", "-A", "--after-context",
  "-B", "--before-context", "-C", "--context", "--label",
  "--color", "--colour", "--include", "--exclude", "--exclude-dir",
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

function tryParseGrepArgs(args: string[]): ParsedGrepCommand | null {
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
  let isRecursive = tool === "rg";
  let patternConsumed = false;

  let i = 0;
  while (i < rest.length) {
    const arg = rest[i];

    if (arg === "--") {
      files.push(...rest.slice(i + 1));
      break;
    }

    if (arg.startsWith("-")) {
      flags.push(arg);

      if (arg === "-r" || arg === "-R" || arg === "--recursive") isRecursive = true;
      if (/^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(arg) && !arg.startsWith("--")) isRecursive = true;

      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        const flagName = arg.slice(0, eqIdx);
        const flagValue = arg.slice(eqIdx + 1);
        if (flagName === "--include") includeGlobs.push(flagValue);
        else if (flagName === "--type" || flagName === "-t") typeFilters.push(flagValue);
        else if (flagName === "-e" || flagName === "--regexp") explicitPatterns.push(flagValue);
        i++;
        continue;
      }

      if (arg === "-e" || arg === "--regexp") {
        if (i + 1 < rest.length) { explicitPatterns.push(rest[i + 1]); i += 2; continue; }
      }
      if (arg === "--include") {
        if (i + 1 < rest.length) { includeGlobs.push(rest[i + 1]); i += 2; continue; }
      }
      if (arg === "--type" || arg === "-t") {
        if (i + 1 < rest.length) { typeFilters.push(rest[i + 1]); i += 2; continue; }
      }
      if (GREP_VALUE_FLAGS.has(arg)) { i += 2; continue; }

      i++;
      continue;
    }

    if (!patternConsumed && explicitPatterns.length === 0) {
      patternConsumed = true;
      explicitPatterns.push(arg);
    } else {
      files.push(arg);
    }
    i++;
  }

  return { tool, pattern: explicitPatterns.join(" "), files, flags, includeGlobs, typeFilters, isRecursive };
}

function parseGrepCommand(cmd: string): ParsedGrepCommand | null {
  const tokens = parseShell(cmd);
  const args: string[] = [];

  for (const token of tokens) {
    if (typeof token === "string") {
      args.push(token);
    } else if (typeof token === "object" && token !== null) {
      if ("pattern" in token) {
        args.push(String(token.pattern));
      } else if ("op" in token) {
        const result = tryParseGrepArgs(args);
        if (result) return result;
        args.length = 0;
      }
    }
  }

  return tryParseGrepArgs(args);
}

// ─── Test runner ────────────────────────────────────────────────────────

interface Expected {
  tool?: string;
  pattern?: string;
  files?: string[];
  recursive?: boolean;
  includeGlobs?: string[];
  typeFilters?: string[];
}

interface TestCase {
  cmd: string;
  expect: Expected | null;
}

const tests: TestCase[] = [
  // ── Basic pattern and file extraction ──────────────────────────────
  {
    cmd: 'grep -rn "function" src/',
    expect: { pattern: "function", files: ["src/"], recursive: true },
  },
  {
    cmd: 'rg "class Controller" src/app.ts',
    expect: { pattern: "class Controller", files: ["src/app.ts"], recursive: true },
  },
  {
    cmd: 'grep "something" log_of_function_tests.ts',
    expect: { pattern: "something", files: ["log_of_function_tests.ts"], recursive: false },
  },

  // ── Type filters (rg) ─────────────────────────────────────────────
  {
    cmd: 'rg -t ts "interface" src/',
    expect: { pattern: "interface", typeFilters: ["ts"], files: ["src/"] },
  },
  {
    cmd: 'rg --type rust "fn main" src/',
    expect: { pattern: "fn main", typeFilters: ["rust"], files: ["src/"] },
  },

  // ── Include globs (grep) ──────────────────────────────────────────
  {
    cmd: 'grep --include="*.ts" -rn "class" .',
    expect: { pattern: "class", includeGlobs: ["*.ts"], recursive: true },
  },
  {
    cmd: "grep -rn \"def \" --include=*.py .",
    expect: { pattern: "def ", includeGlobs: ["*.py"], recursive: true },
  },
  {
    cmd: 'grep --include *.rs -rn "struct" .',
    expect: { pattern: "struct", includeGlobs: ["*.rs"], recursive: true },
  },

  // ── Multiple -e patterns ──────────────────────────────────────────
  {
    cmd: 'rg -e "fn" -e "struct" src/',
    expect: { pattern: "fn struct", files: ["src/"] },
  },

  // ── Pipelines ─────────────────────────────────────────────────────
  {
    cmd: 'cat foo.ts | grep "error"',
    expect: { tool: "grep", pattern: "error", files: [] },
  },
  {
    cmd: "echo hello | rg pattern",
    expect: { tool: "rg", pattern: "pattern" },
  },
  {
    cmd: 'find . -name "*.ts" | xargs grep "TODO"',
    expect: { tool: "grep", pattern: "TODO" },
  },

  // ── -- separator ──────────────────────────────────────────────────
  {
    cmd: 'grep "pattern" -- -weird-file.ts other.rs',
    expect: { pattern: "pattern", files: ["-weird-file.ts", "other.rs"] },
  },

  // ── Combined short flags ──────────────────────────────────────────
  {
    cmd: 'grep -rin "enum" src/',
    expect: { pattern: "enum", files: ["src/"], recursive: true },
  },

  // ── Full path to binary ───────────────────────────────────────────
  {
    cmd: '/usr/bin/grep -rn "trait" src/',
    expect: { tool: "grep", pattern: "trait", recursive: true },
  },

  // ── Non-grep commands return null ─────────────────────────────────
  {
    cmd: "ls -la",
    expect: null,
  },
  {
    cmd: "find . -name '*.ts'",
    expect: null,
  },

  // ── Compound commands ─────────────────────────────────────────────
  {
    cmd: 'cd src && rg "impl" .',
    expect: { tool: "rg", pattern: "impl", files: ["."] },
  },
];

// ─── Run tests ──────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;

for (const { cmd, expect } of tests) {
  const result = parseGrepCommand(cmd);
  let ok = true;

  if (expect === null) {
    ok = result === null;
  } else if (!result) {
    ok = false;
  } else {
    if (expect.pattern !== undefined && result.pattern !== expect.pattern) ok = false;
    if (expect.files && JSON.stringify(result.files) !== JSON.stringify(expect.files)) ok = false;
    if (expect.tool && result.tool !== expect.tool) ok = false;
    if (expect.recursive !== undefined && result.isRecursive !== expect.recursive) ok = false;
    if (expect.typeFilters && JSON.stringify(result.typeFilters) !== JSON.stringify(expect.typeFilters)) ok = false;
    if (expect.includeGlobs && JSON.stringify(result.includeGlobs) !== JSON.stringify(expect.includeGlobs)) ok = false;
  }

  if (ok) {
    pass++;
    console.log(`  ✓ ${cmd}`);
  } else {
    fail++;
    console.log(`  ✗ ${cmd}`);
    console.log(`    expected: ${JSON.stringify(expect)}`);
    console.log(`    got:      ${JSON.stringify(result)}`);
  }
}

console.log();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
