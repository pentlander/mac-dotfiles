/**
 * Tree-sitter symbol extraction → embedding text.
 *
 * Reuses parseFile() and extractSymbols() from the sibling tree-sitter-nav extension.
 * Extracts functions, methods, types, structs, interfaces, classes, constants, enums.
 * Formats each symbol as: "<lang> | <relative-path> | <signature>"
 */

import { parseFile } from "../tree-sitter-nav/parser.js";
import { extractSymbols, type SymbolInfo, type ExtractOptions } from "../tree-sitter-nav/symbols.js";
import { getLanguageForExtension, getSupportedExtensions } from "../tree-sitter-nav/languages.js";
import { relative, extname, basename } from "node:path";

/** Config file extensions — only index blocks/sections, not leaf properties */
const CONFIG_EXTENSIONS = new Set([
  ".toml", ".yaml", ".yml", ".hcl", ".tf", ".tfvars",
]);

export interface ChunkInfo {
  /** The text to embed: "go | path/to/file.go | func signature(...)" */
  embeddingText: string;
  /** Symbol name */
  name: string;
  /** Symbol kind (function, method, type, struct, etc.) */
  kind: string;
  /** Language name */
  language: string;
  /** Start line (1-based) */
  line: number;
  /** End line (1-based) */
  endLine: number | null;
  /** Signature string if available */
  signature: string | null;
  /** Relative file path */
  filePath: string;
}

/** Symbol kinds we want to index. */
const INDEXABLE_KINDS = new Set([
  "function",
  "method",
  "type",
  "struct",
  "interface",
  "class",
  "enum",
  "constant",
  "trait",
  "impl",
  "module",
  "property",
  "block",     // TOML sections, HCL/Terraform blocks
  "resource",  // Terraform resources
  "data",      // Terraform data sources
]);

/**
 * Extract indexable symbols from a file and format them as embedding text.
 *
 * @param filePath Absolute path to the file
 * @param cwd Working directory (for relative path computation)
 * @returns Array of ChunkInfo, one per symbol
 */
export async function extractChunks(filePath: string, cwd: string): Promise<ChunkInfo[]> {
  const { tree, language, source } = await parseFile(filePath, cwd);

  const relPath = relative(cwd, filePath);
  const ext = extname(filePath).toLowerCase();
  const isConfig = CONFIG_EXTENSIONS.has(ext);

  const opts: ExtractOptions = {
    signatures: true,
    topLevelOnly: isConfig, // Config files: only top-level blocks, not leaf keys
  };

  const symbols = extractSymbols(tree, language.grammar, source, opts);
  const chunks: ChunkInfo[] = [];

  flattenSymbols(symbols, relPath, language.name, chunks, isConfig);

  return chunks;
}

/**
 * Recursively flatten symbols into ChunkInfo entries.
 */
function flattenSymbols(
  symbols: SymbolInfo[],
  relPath: string,
  langName: string,
  out: ChunkInfo[],
  isConfig = false,
): void {
  for (const sym of symbols) {
    // For config files, skip leaf properties — only keep blocks/sections/resources
    if (isConfig && sym.kind === "property") continue;

    if (INDEXABLE_KINDS.has(sym.kind)) {
      const displaySig = sym.signature ?? sym.name;
      const embeddingText = `${langName.toLowerCase()} | ${relPath} | ${displaySig}`;

      out.push({
        embeddingText,
        name: sym.name,
        kind: sym.kind,
        language: langName.toLowerCase(),
        line: sym.startLine,
        endLine: sym.endLine,
        signature: sym.signature ?? null,
        filePath: relPath,
      });
    }

    // Recurse into children (methods inside classes, etc.) — but not for config files
    if (sym.children.length > 0 && !isConfig) {
      flattenSymbols(sym.children, relPath, langName, out, isConfig);
    }
  }
}

/**
 * Check if a file extension is supported for indexing.
 */
export function isSupportedFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return getSupportedExtensions().includes(ext);
}

/**
 * Get all supported file extensions.
 */
export function getSupportedExts(): string[] {
  return getSupportedExtensions();
}
