/**
 * Language detection and grammar mapping.
 *
 * Maps file extensions to tree-sitter grammar names (matching the .wasm filenames
 * in tree-sitter-wasms and @tree-sitter-grammars packages).
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface LanguageInfo {
  /** Tree-sitter grammar name (matches .wasm filename without prefix/suffix) */
  grammar: string;
  /** Human-readable language name */
  name: string;
  /** Source of the .wasm file: "wasms" for tree-sitter-wasms, "hcl" for @tree-sitter-grammars/tree-sitter-hcl */
  source: "wasms" | "hcl";
}

const EXTENSION_MAP: Record<string, LanguageInfo> = {
  // TypeScript / JavaScript
  ".ts": { grammar: "typescript", name: "TypeScript", source: "wasms" },
  ".tsx": { grammar: "tsx", name: "TSX", source: "wasms" },
  ".js": { grammar: "javascript", name: "JavaScript", source: "wasms" },
  ".jsx": { grammar: "javascript", name: "JavaScript", source: "wasms" },
  ".mjs": { grammar: "javascript", name: "JavaScript", source: "wasms" },
  ".cjs": { grammar: "javascript", name: "JavaScript", source: "wasms" },
  ".mts": { grammar: "typescript", name: "TypeScript", source: "wasms" },
  ".cts": { grammar: "typescript", name: "TypeScript", source: "wasms" },

  // Python
  ".py": { grammar: "python", name: "Python", source: "wasms" },
  ".pyi": { grammar: "python", name: "Python", source: "wasms" },

  // Rust
  ".rs": { grammar: "rust", name: "Rust", source: "wasms" },

  // Go
  ".go": { grammar: "go", name: "Go", source: "wasms" },

  // Java
  ".java": { grammar: "java", name: "Java", source: "wasms" },

  // Kotlin
  ".kt": { grammar: "kotlin", name: "Kotlin", source: "wasms" },
  ".kts": { grammar: "kotlin", name: "Kotlin", source: "wasms" },

  // Swift
  ".swift": { grammar: "swift", name: "Swift", source: "wasms" },

  // Ruby
  ".rb": { grammar: "ruby", name: "Ruby", source: "wasms" },

  // PHP
  ".php": { grammar: "php", name: "PHP", source: "wasms" },

  // C#
  ".cs": { grammar: "c_sharp", name: "C#", source: "wasms" },

  // Scala
  ".scala": { grammar: "scala", name: "Scala", source: "wasms" },

  // Lua
  ".lua": { grammar: "lua", name: "Lua", source: "wasms" },

  // Bash / Shell
  ".sh": { grammar: "bash", name: "Bash", source: "wasms" },
  ".bash": { grammar: "bash", name: "Bash", source: "wasms" },
  ".zsh": { grammar: "bash", name: "Bash", source: "wasms" },

  // Zig
  ".zig": { grammar: "zig", name: "Zig", source: "wasms" },

  // Elixir
  ".ex": { grammar: "elixir", name: "Elixir", source: "wasms" },
  ".exs": { grammar: "elixir", name: "Elixir", source: "wasms" },

  // Dart
  ".dart": { grammar: "dart", name: "Dart", source: "wasms" },

  // OCaml
  ".ml": { grammar: "ocaml", name: "OCaml", source: "wasms" },
  ".mli": { grammar: "ocaml", name: "OCaml", source: "wasms" },

  // YAML
  ".yml": { grammar: "yaml", name: "YAML", source: "wasms" },
  ".yaml": { grammar: "yaml", name: "YAML", source: "wasms" },

  // TOML
  ".toml": { grammar: "toml", name: "TOML", source: "wasms" },

  // HCL / Terraform
  ".hcl": { grammar: "hcl", name: "HCL", source: "hcl" },
  ".tf": { grammar: "terraform", name: "Terraform", source: "hcl" },
  ".tfvars": { grammar: "terraform", name: "Terraform", source: "hcl" },
};

/** Get language info for a file extension (including the dot). Returns undefined if unsupported. */
export function getLanguageForExtension(ext: string): LanguageInfo | undefined {
  return EXTENSION_MAP[ext.toLowerCase()];
}

/** Get all supported file extensions. */
export function getSupportedExtensions(): string[] {
  return Object.keys(EXTENSION_MAP);
}

/**
 * Map from ripgrep type names (e.g. "ts", "rust", "py") to file extensions.
 * Derived from EXTENSION_MAP — includes both the grammar name and common short aliases.
 */
export function getRgTypeMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [ext, info] of Object.entries(EXTENSION_MAP)) {
    // Map grammar name → first extension (e.g. "typescript" → ".ts")
    if (!map[info.grammar]) {
      map[info.grammar] = ext;
    }
    // Map human-readable name lowercase → first extension (e.g. "typescript" → ".ts")
    const nameLower = info.name.toLowerCase();
    if (!map[nameLower]) {
      map[nameLower] = ext;
    }
    // Map bare extension without dot as alias (e.g. "ts" → ".ts", "py" → ".py")
    const bare = ext.slice(1);
    if (!map[bare]) {
      map[bare] = ext;
    }
  }
  return map;
}

/** Resolve the path to a .wasm grammar file. */
export function getWasmPath(lang: LanguageInfo): string {
  if (lang.source === "hcl") {
    return join(
      __dirname,
      "node_modules",
      "@tree-sitter-grammars",
      "tree-sitter-hcl",
      `tree-sitter-${lang.grammar}.wasm`,
    );
  }
  return join(
    __dirname,
    "node_modules",
    "tree-sitter-wasms",
    "out",
    `tree-sitter-${lang.grammar}.wasm`,
  );
}
