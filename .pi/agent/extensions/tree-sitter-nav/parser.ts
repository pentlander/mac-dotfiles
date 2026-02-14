/**
 * Tree-sitter parser initialization, WASM loading, and parse caching.
 */

import Parser from "web-tree-sitter";
import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { getLanguageForExtension, getWasmPath, type LanguageInfo } from "./languages.js";

let initialized = false;

/** Loaded language instances, keyed by grammar name. */
const languageCache = new Map<string, Parser.Language>();

/** Parsed tree cache, keyed by absolute path. */
const treeCache = new Map<string, { tree: Parser.Tree; mtimeMs: number; grammar: string }>();

/** Shared parser instance. */
let parser: Parser;

/** Initialize web-tree-sitter WASM runtime. Must be called once before any parsing. */
export async function ensureInit(): Promise<void> {
  if (initialized) return;
  await Parser.init();
  parser = new Parser();
  initialized = true;
}

/** Load a language grammar, caching the result. */
async function loadLanguage(lang: LanguageInfo): Promise<Parser.Language> {
  const cached = languageCache.get(lang.grammar);
  if (cached) return cached;

  const wasmPath = getWasmPath(lang);
  const language = await Parser.Language.load(wasmPath);
  languageCache.set(lang.grammar, language);
  return language;
}

export interface ParseResult {
  tree: Parser.Tree;
  language: LanguageInfo;
  source: string;
}

/**
 * Parse a file, returning the tree, language info, and source text.
 * Uses caching based on file mtime to avoid re-parsing unchanged files.
 */
export async function parseFile(filePath: string, cwd: string): Promise<ParseResult> {
  await ensureInit();

  const absPath = resolve(cwd, filePath);
  const ext = extname(absPath);
  const lang = getLanguageForExtension(ext);
  if (!lang) {
    throw new Error(`Unsupported language for extension "${ext}". Supported: ${getSupportedExtList()}`);
  }

  const stat = statSync(absPath);
  const cached = treeCache.get(absPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.grammar === lang.grammar) {
    const source = readFileSync(absPath, "utf-8");
    return { tree: cached.tree, language: lang, source };
  }

  const source = readFileSync(absPath, "utf-8");
  const language = await loadLanguage(lang);
  parser.setLanguage(language);
  const tree = parser.parse(source);
  if (!tree) {
    throw new Error(`Failed to parse ${absPath}`);
  }

  treeCache.set(absPath, { tree, mtimeMs: stat.mtimeMs, grammar: lang.grammar });
  return { tree, language: lang, source };
}

/** Clear the parse cache (call on shutdown). */
export function clearCache(): void {
  for (const entry of treeCache.values()) {
    entry.tree.delete();
  }
  treeCache.clear();
}

function getSupportedExtList(): string {
  const exts = [".ts", ".tsx", ".js", ".py", ".rs", ".go", ".java", ".kt", ".rb", ".swift", ".cs", ".lua", ".sh", ".zig", ".ex", ".dart", ".ml", ".yml", ".toml", ".hcl", ".tf"];
  return exts.join(", ");
}
