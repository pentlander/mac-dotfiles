/**
 * Symbol extraction from tree-sitter ASTs.
 *
 * Walks the AST and extracts meaningful symbols (functions, classes, methods, etc.)
 * with their names, kinds, line ranges, nesting, and optional signatures.
 */

import type Parser from "web-tree-sitter";

type Node = Parser.SyntaxNode;
type Tree = Parser.Tree;

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "struct"
  | "trait"
  | "impl"
  | "module"
  | "variable"
  | "constant"
  | "property"
  | "block"
  | "resource"
  | "data"
  | "provider"
  | "output"
  | "locals";

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  startLine: number; // 1-based
  endLine: number; // 1-based
  signature?: string;
  children: SymbolInfo[];
}

/** Node types we care about, per grammar. Maps node type → symbol kind. */
interface LanguageSpec {
  /** Map of AST node type → symbol kind */
  nodeTypes: Record<string, SymbolKind>;
  /** Extract the symbol name from a node. Return undefined to skip. */
  getName: (node: Node, kind: SymbolKind) => string | undefined;
  /** Extract the signature from a node. Return undefined if none. */
  getSignature?: (node: Node, source: string) => string | undefined;
  /** Dynamically resolve the symbol kind (e.g. function → method inside a class). */
  resolveKind?: (node: Node, kind: SymbolKind) => SymbolKind;
  /** Node types that can contain nested symbols (classes, impl blocks, etc.) */
  containerTypes?: Set<string>;
}

// ─── Name extraction helpers ────────────────────────────────────────────

function fieldName(node: Node, field: string): string | undefined {
  return node.childForFieldName(field)?.text;
}

function firstChildOfType(node: Node, type: string): Node | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === type) return child;
  }
  return undefined;
}

/** Check if a node is inside a class definition (walking up parents). */
function isInsideClass(node: Node): boolean {
  let current = node.parent;
  while (current) {
    if (
      current.type === "class_definition" ||
      current.type === "class_declaration" ||
      current.type === "class_body"
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

// ─── Signature extraction helpers ───────────────────────────────────────

/** Extract text from the node's first line up to and including the parameter list / return type. */
function extractSignatureLine(node: Node, source: string): string | undefined {
  const startIndex = node.startIndex;
  // Find the end of the first meaningful line (up to opening brace or newline)
  const text = source.slice(startIndex, Math.min(startIndex + 500, source.length));
  const braceIdx = text.indexOf("{");
  const colonIdx = text.indexOf(":");
  // For single-line arrow functions, take the whole line
  const newlineIdx = text.indexOf("\n");

  let end = text.length;
  if (braceIdx >= 0) end = Math.min(end, braceIdx);
  if (newlineIdx >= 0) end = Math.min(end, newlineIdx);

  let sig = text.slice(0, end).trim();
  // Clean up trailing punctuation
  sig = sig.replace(/[{:\s]+$/, "").trim();
  return sig || undefined;
}

/** Extract parameters portion: "(param1, param2, ...)" */
function extractParams(node: Node): string | undefined {
  const params =
    node.childForFieldName("parameters") ??
    node.childForFieldName("params") ??
    firstChildOfType(node, "formal_parameters") ??
    firstChildOfType(node, "parameters") ??
    firstChildOfType(node, "parameter_list");
  return params?.text;
}

/** Extract return type annotation if present. */
function extractReturnType(node: Node): string | undefined {
  const ret = node.childForFieldName("return_type") ?? node.childForFieldName("result");
  return ret?.text;
}

/** Build a compact signature from name + params + return type. */
function buildSignature(name: string, node: Node): string | undefined {
  const params = extractParams(node);
  if (!params) return undefined;
  const ret = extractReturnType(node);
  if (!ret) return `${name}${params}`;
  // Return type text may already include ": " or " " prefix depending on grammar
  const retText = ret.replace(/^:\s*/, "").trim();
  return `${name}${params}: ${retText}`;
}

// ─── Language specs ─────────────────────────────────────────────────────

function tsGetName(node: Node, kind: SymbolKind): string | undefined {
  // For variable declarations with arrow functions, get the variable name
  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    const declarator =
      firstChildOfType(node, "variable_declarator") ??
      firstChildOfType(node, "lexical_declaration");
    if (declarator) {
      const init = declarator.childForFieldName("value");
      if (init && (init.type === "arrow_function" || init.type === "function_expression" || init.type === "function")) {
        return declarator.childForFieldName("name")?.text;
      }
    }
    return undefined; // Skip non-function variable declarations
  }
  if (node.type === "export_statement") {
    // Check if this exports a declaration we care about
    const decl = node.childForFieldName("declaration");
    if (decl) return tsGetName(decl, kind);
    return undefined;
  }
  return fieldName(node, "name");
}

function tsGetSignature(node: Node, source: string): string | undefined {
  const name = tsGetName(node, "function");
  if (!name) return undefined;

  // For variable declarations (arrow functions)
  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    const declarator = firstChildOfType(node, "variable_declarator");
    if (declarator) {
      const init = declarator.childForFieldName("value");
      if (init) return buildSignature(name, init);
    }
    return undefined;
  }

  return buildSignature(name, node);
}

const typescriptSpec: LanguageSpec = {
  nodeTypes: {
    function_declaration: "function",
    generator_function_declaration: "function",
    class_declaration: "class",
    abstract_class_declaration: "class",
    method_definition: "method",
    interface_declaration: "interface",
    type_alias_declaration: "type",
    enum_declaration: "enum",
    lexical_declaration: "function", // arrow function const x = () => {}
    variable_declaration: "function", // var/let function expressions
    module: "module", // namespace
  },
  getName: tsGetName,
  getSignature: tsGetSignature,
  containerTypes: new Set([
    "class_declaration",
    "abstract_class_declaration",
    "interface_declaration",
    "enum_declaration",
    "module",
  ]),
};

// JavaScript shares most of TypeScript's spec
const javascriptSpec: LanguageSpec = {
  nodeTypes: {
    function_declaration: "function",
    generator_function_declaration: "function",
    class_declaration: "class",
    method_definition: "method",
    lexical_declaration: "function",
    variable_declaration: "function",
  },
  getName: tsGetName,
  getSignature: tsGetSignature,
  containerTypes: new Set(["class_declaration"]),
};

const pythonSpec: LanguageSpec = {
  nodeTypes: {
    function_definition: "function",
    class_definition: "class",
    decorated_definition: "function", // Resolved to inner definition's kind dynamically
  },
  getName(node, kind) {
    if (node.type === "decorated_definition") {
      const def = node.childForFieldName("definition");
      if (def) return fieldName(def, "name");
      return undefined;
    }
    return fieldName(node, "name");
  },
  /** Resolve the actual kind for decorated definitions and methods inside classes. */
  resolveKind(node, kind) {
    if (node.type === "decorated_definition") {
      const def = node.childForFieldName("definition");
      if (def?.type === "class_definition") return "class";
      if (def?.type === "function_definition") {
        // If inside a class, it's a method
        return isInsideClass(node) ? "method" : "function";
      }
    }
    if (node.type === "function_definition" && isInsideClass(node)) {
      return "method";
    }
    return kind;
  },
  getSignature(node, source) {
    let target = node;
    if (node.type === "decorated_definition") {
      const def = node.childForFieldName("definition");
      if (def) target = def;
    }
    const name = fieldName(target, "name");
    if (!name) return undefined;
    const params = target.childForFieldName("parameters");
    const ret = target.childForFieldName("return_type");
    if (!params) return undefined;
    return ret ? `${name}${params.text} -> ${ret.text}` : `${name}${params.text}`;
  },
  containerTypes: new Set(["class_definition"]),
};

const rustSpec: LanguageSpec = {
  nodeTypes: {
    function_item: "function",
    struct_item: "struct",
    enum_item: "enum",
    impl_item: "impl",
    trait_item: "trait",
    mod_item: "module",
    type_item: "type",
    const_item: "constant",
    static_item: "constant",
    macro_definition: "function",
  },
  getName(node, kind) {
    if (kind === "impl") {
      // impl Type or impl Trait for Type
      const type = node.childForFieldName("type");
      const trait = node.childForFieldName("trait");
      if (trait && type) return `${trait.text} for ${type.text}`;
      return type?.text;
    }
    return fieldName(node, "name");
  },
  getSignature(node, source) {
    const name = fieldName(node, "name");
    if (!name) return undefined;
    return buildSignature(name, node);
  },
  containerTypes: new Set(["impl_item", "trait_item", "mod_item", "struct_item", "enum_item"]),
};

const goSpec: LanguageSpec = {
  nodeTypes: {
    function_declaration: "function",
    method_declaration: "method",
    type_declaration: "type",
  },
  getName(node, kind) {
    if (node.type === "type_declaration") {
      const spec = firstChildOfType(node, "type_spec");
      return spec ? fieldName(spec, "name") : undefined;
    }
    return fieldName(node, "name");
  },
  resolveKind(node, kind) {
    // Resolve type_declaration to struct/interface based on the inner type_spec's value
    if (node.type === "type_declaration") {
      const spec = firstChildOfType(node, "type_spec");
      if (spec) {
        const value = spec.childForFieldName("type");
        if (value) {
          if (value.type === "struct_type") return "struct";
          if (value.type === "interface_type") return "interface";
        }
      }
    }
    return kind;
  },
  getSignature(node, source) {
    const name = fieldName(node, "name");
    if (!name) return undefined;

    if (node.type === "method_declaration") {
      const receiver = node.childForFieldName("receiver");
      const params = node.childForFieldName("parameters");
      const result = node.childForFieldName("result");
      const recv = receiver ? `${receiver.text} ` : "";
      const p = params?.text ?? "()";
      return result ? `${recv}${name}${p} ${result.text}` : `${recv}${name}${p}`;
    }

    return buildSignature(name, node);
  },
};

const javaSpec: LanguageSpec = {
  nodeTypes: {
    class_declaration: "class",
    interface_declaration: "interface",
    enum_declaration: "enum",
    method_declaration: "method",
    constructor_declaration: "method",
    annotation_type_declaration: "interface",
    record_declaration: "class",
  },
  getName: (node) => fieldName(node, "name"),
  getSignature(node, source) {
    const name = fieldName(node, "name");
    if (!name) return undefined;
    return buildSignature(name, node);
  },
  containerTypes: new Set([
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "record_declaration",
  ]),
};

const kotlinSpec: LanguageSpec = {
  nodeTypes: {
    function_declaration: "function",
    class_declaration: "class",
    object_declaration: "class",
    interface_declaration: "interface",
    property_declaration: "property",
  },
  getName: (node) => {
    const simpleId = firstChildOfType(node, "simple_identifier");
    return simpleId?.text ?? fieldName(node, "name");
  },
  getSignature(node, source) {
    return extractSignatureLine(node, source);
  },
  containerTypes: new Set(["class_declaration", "object_declaration", "interface_declaration"]),
};

const rubySpec: LanguageSpec = {
  nodeTypes: {
    method: "method",
    singleton_method: "method",
    class: "class",
    module: "module",
  },
  getName: (node) => fieldName(node, "name"),
  getSignature(node, source) {
    return extractSignatureLine(node, source);
  },
  containerTypes: new Set(["class", "module"]),
};

const swiftSpec: LanguageSpec = {
  nodeTypes: {
    function_declaration: "function",
    class_declaration: "class",
    struct_declaration: "struct",
    enum_declaration: "enum",
    protocol_declaration: "interface",
    extension_declaration: "impl",
  },
  getName: (node) => fieldName(node, "name"),
  getSignature(node, source) {
    return extractSignatureLine(node, source);
  },
  containerTypes: new Set([
    "class_declaration",
    "struct_declaration",
    "enum_declaration",
    "protocol_declaration",
    "extension_declaration",
  ]),
};

const csharpSpec: LanguageSpec = {
  nodeTypes: {
    class_declaration: "class",
    interface_declaration: "interface",
    struct_declaration: "struct",
    enum_declaration: "enum",
    method_declaration: "method",
    constructor_declaration: "method",
    property_declaration: "property",
    record_declaration: "class",
    namespace_declaration: "module",
  },
  getName: (node) => fieldName(node, "name"),
  getSignature(node, source) {
    const name = fieldName(node, "name");
    if (!name) return undefined;
    return buildSignature(name, node);
  },
  containerTypes: new Set([
    "class_declaration",
    "interface_declaration",
    "struct_declaration",
    "namespace_declaration",
  ]),
};

const luaSpec: LanguageSpec = {
  nodeTypes: {
    function_declaration: "function",
    local_function_declaration: "function",
  },
  getName: (node) => fieldName(node, "name"),
  getSignature(node, source) {
    return extractSignatureLine(node, source);
  },
};

const bashSpec: LanguageSpec = {
  nodeTypes: {
    function_definition: "function",
  },
  getName: (node) => fieldName(node, "name"),
};

const scalaSpec: LanguageSpec = {
  nodeTypes: {
    function_definition: "function",
    val_definition: "variable",
    var_definition: "variable",
    class_definition: "class",
    object_definition: "class",
    trait_definition: "trait",
  },
  getName: (node) => fieldName(node, "name"),
  getSignature(node, source) {
    return extractSignatureLine(node, source);
  },
  containerTypes: new Set(["class_definition", "object_definition", "trait_definition"]),
};

const zigSpec: LanguageSpec = {
  nodeTypes: {
    FnProto: "function",
    TestDecl: "function",
    // Container declarations are handled via VarDecl
  },
  getName(node) {
    // Zig function name is in the fn_name field or first identifier
    return fieldName(node, "name") ?? firstChildOfType(node, "IDENTIFIER")?.text;
  },
  getSignature(node, source) {
    return extractSignatureLine(node, source);
  },
};

const elixirSpec: LanguageSpec = {
  nodeTypes: {
    call: "function", // def, defp, defmodule, etc. are calls in Elixir's AST
  },
  getName(node) {
    const target = firstChildOfType(node, "identifier");
    if (!target) return undefined;
    const name = target.text;
    // Only extract def, defp, defmodule, defprotocol, defimpl
    if (!["def", "defp", "defmodule", "defprotocol", "defimpl", "defmacro"].includes(name)) {
      return undefined;
    }
    // The actual name is in the arguments
    const args = node.childForFieldName("arguments");
    if (args) {
      const firstArg = args.child(0);
      if (firstArg) {
        // For defmodule, first arg is the module name alias
        if (name === "defmodule") return firstArg.text;
        // For def/defp, first arg is a call with the function name
        if (firstArg.type === "call") {
          const fnName = firstChildOfType(firstArg, "identifier");
          return fnName?.text;
        }
        if (firstArg.type === "identifier") return firstArg.text;
      }
    }
    return undefined;
  },
  getSignature(node, source) {
    return extractSignatureLine(node, source);
  },
};

const phpSpec: LanguageSpec = {
  nodeTypes: {
    function_definition: "function",
    method_declaration: "method",
    class_declaration: "class",
    interface_declaration: "interface",
    trait_declaration: "trait",
    enum_declaration: "enum",
    namespace_definition: "module",
  },
  getName: (node) => fieldName(node, "name"),
  getSignature(node, source) {
    const name = fieldName(node, "name");
    if (!name) return undefined;
    return buildSignature(name, node);
  },
  containerTypes: new Set([
    "class_declaration",
    "interface_declaration",
    "trait_declaration",
    "enum_declaration",
  ]),
};

const dartSpec: LanguageSpec = {
  nodeTypes: {
    function_signature: "function",
    method_signature: "method",
    class_definition: "class",
    enum_declaration: "enum",
    mixin_declaration: "class",
    extension_declaration: "impl",
  },
  getName: (node) => fieldName(node, "name"),
  getSignature(node, source) {
    return extractSignatureLine(node, source);
  },
  containerTypes: new Set(["class_definition", "enum_declaration", "mixin_declaration"]),
};

const ocamlSpec: LanguageSpec = {
  nodeTypes: {
    let_binding: "function",
    type_binding: "type",
    module_binding: "module",
    class_binding: "class",
    method_definition: "method",
  },
  getName(node) {
    const pattern = node.childForFieldName("pattern");
    if (pattern) return pattern.text;
    return fieldName(node, "name");
  },
  getSignature(node, source) {
    return extractSignatureLine(node, source);
  },
  containerTypes: new Set(["module_binding", "class_binding"]),
};

// HCL / Terraform have a different structure - blocks with labels
const hclSpec: LanguageSpec = {
  nodeTypes: {
    block: "block",
  },
  getName(node) {
    // HCL blocks: resource "type" "name" { ... }
    // First identifier is the block type, subsequent string_lit/identifiers are labels
    const children = node.children;
    const parts: string[] = [];
    for (const child of children) {
      if (child.type === "identifier") parts.push(child.text);
      if (child.type === "string_lit") parts.push(child.text.replace(/"/g, ""));
      if (child.type === "body" || child.type === "{") break;
    }
    if (parts.length === 0) return undefined;

    // Map HCL block types to more specific kinds
    const blockType = parts[0];
    return parts.join(" ");
  },
  containerTypes: new Set(["block"]),
};

const terraformSpec: LanguageSpec = {
  nodeTypes: {
    block: "block",
  },
  getName(node) {
    const children = node.children;
    const parts: string[] = [];
    for (const child of children) {
      if (child.type === "identifier") parts.push(child.text);
      if (child.type === "string_lit") parts.push(child.text.replace(/"/g, ""));
      if (child.type === "body" || child.type === "{") break;
    }
    return parts.length > 0 ? parts.join(" ") : undefined;
  },
  containerTypes: new Set(["block"]),
};

// YAML - top-level keys as symbols
const yamlSpec: LanguageSpec = {
  nodeTypes: {
    block_mapping_pair: "property",
  },
  getName(node) {
    const key = node.childForFieldName("key");
    return key?.text;
  },
  containerTypes: new Set(["block_mapping_pair"]),
};

const tomlSpec: LanguageSpec = {
  nodeTypes: {
    table: "block",
    table_array_element: "block",
    pair: "property",
  },
  getName(node) {
    if (node.type === "table" || node.type === "table_array_element") {
      // Get the [section] name
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && (child.type === "bare_key" || child.type === "dotted_key" || child.type === "quoted_key")) {
          return child.text;
        }
      }
      return undefined;
    }
    // pair
    return firstChildOfType(node, "bare_key")?.text ?? firstChildOfType(node, "quoted_key")?.text;
  },
  containerTypes: new Set(["table", "table_array_element"]),
};

// ─── Grammar → Spec mapping ────────────────────────────────────────────

const SPECS: Record<string, LanguageSpec> = {
  typescript: typescriptSpec,
  tsx: typescriptSpec,
  javascript: javascriptSpec,
  python: pythonSpec,
  rust: rustSpec,
  go: goSpec,
  java: javaSpec,
  kotlin: kotlinSpec,
  ruby: rubySpec,
  swift: swiftSpec,
  c_sharp: csharpSpec,
  lua: luaSpec,
  bash: bashSpec,
  scala: scalaSpec,
  zig: zigSpec,
  elixir: elixirSpec,
  php: phpSpec,
  dart: dartSpec,
  ocaml: ocamlSpec,
  hcl: hclSpec,
  terraform: terraformSpec,
  yaml: yamlSpec,
  toml: tomlSpec,
};

// ─── Symbol extraction ─────────────────────────────────────────────────

export interface ExtractOptions {
  /** Include function/method signatures */
  signatures?: boolean;
  /** Filter by symbol kind */
  kind?: string;
  /** Regex pattern to filter symbols by name */
  namePattern?: string;
  /** Only extract top-level symbols (for directory scanning) */
  topLevelOnly?: boolean;
  /** Maximum depth for YAML/TOML/HCL nesting (default: 2 for dir scans, unlimited otherwise) */
  maxDepth?: number;
}

/**
 * Extract symbols from a parsed tree.
 */
export function extractSymbols(
  tree: Tree,
  grammar: string,
  source: string,
  options: ExtractOptions = {},
): SymbolInfo[] {
  const spec = SPECS[grammar];
  if (!spec) return [];

  const symbols: SymbolInfo[] = [];
  walkNode(tree.rootNode, spec, source, symbols, options, 0);

  let result = symbols;

  // Apply kind filter
  if (options.kind) {
    result = filterByKind(result, options.kind);
  }

  // Apply name pattern filter
  if (options.namePattern) {
    // Strip inline flags like (?i) — we already apply case-insensitive
    const cleaned = options.namePattern.replace(/\(\?[imsu]+\)/g, "");
    const re = new RegExp(cleaned, "i");
    result = filterByName(result, re);
  }

  return result;
}

function walkNode(
  node: Node,
  spec: LanguageSpec,
  source: string,
  results: SymbolInfo[],
  options: ExtractOptions,
  depth: number,
): void {
  if (options.maxDepth !== undefined && depth > options.maxDepth) return;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child || !child.isNamed) continue;

    const rawKind = spec.nodeTypes[child.type];
    if (rawKind) {
      const kind = spec.resolveKind ? spec.resolveKind(child, rawKind) : rawKind;
      let name = spec.getName(child, kind);
      if (name) {
        // Truncate very long names
        if (name.length > 80) name = name.slice(0, 77) + "...";

        const symbol: SymbolInfo = {
          name,
          kind: mapHclKind(kind, name, child),
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          children: [],
        };

        if (options.signatures && spec.getSignature) {
          const sig = spec.getSignature(child, source);
          if (sig) {
            symbol.signature = sig.length > 120 ? sig.slice(0, 117) + "..." : sig;
          }
        }

        // Extract children from container types
        if (!options.topLevelOnly) {
          if (spec.containerTypes?.has(child.type)) {
            walkNode(child, spec, source, symbol.children, options, depth + 1);
          } else if (child.type === "decorated_definition") {
            // For decorated containers (e.g. @dataclass class), recurse into the inner definition
            const innerDef = child.childForFieldName("definition");
            if (innerDef && spec.containerTypes?.has(innerDef.type)) {
              walkNode(innerDef, spec, source, symbol.children, options, depth + 1);
            }
          }
        }

        results.push(symbol);
        continue;
      }
    }

    // For export statements, look inside
    if (child.type === "export_statement" || child.type === "export_declaration") {
      const decl = child.childForFieldName("declaration");
      if (decl) {
        const kind = spec.nodeTypes[decl.type];
        if (kind) {
          const name = spec.getName(decl, kind);
          if (name) {
            const symbol: SymbolInfo = {
              name,
              kind,
              startLine: child.startPosition.row + 1,
              endLine: child.endPosition.row + 1,
              children: [],
            };
            if (options.signatures && spec.getSignature) {
              const sig = spec.getSignature(decl, source);
              if (sig) symbol.signature = sig.length > 120 ? sig.slice(0, 117) + "..." : sig;
            }
            if (!options.topLevelOnly && spec.containerTypes?.has(decl.type)) {
              walkNode(decl, spec, source, symbol.children, options, depth + 1);
            }
            results.push(symbol);
            continue;
          }
        }
      }
    }

    // For decorated_definition in Python, check if it's a class
    if (child.type === "decorated_definition") {
      const def = child.childForFieldName("definition");
      if (def) {
        const defKind = spec.nodeTypes[def.type];
        if (defKind) {
          const name = fieldName(def, "name");
          if (name) {
            const symbol: SymbolInfo = {
              name,
              kind: defKind,
              startLine: child.startPosition.row + 1,
              endLine: child.endPosition.row + 1,
              children: [],
            };
            if (options.signatures && spec.getSignature) {
              const sig = spec.getSignature(child, source);
              if (sig) symbol.signature = sig.length > 120 ? sig.slice(0, 117) + "..." : sig;
            }
            if (!options.topLevelOnly && spec.containerTypes?.has(def.type)) {
              walkNode(def, spec, source, symbol.children, options, depth + 1);
            }
            results.push(symbol);
            continue;
          }
        }
      }
    }

    // Recurse into non-symbol nodes to find nested definitions at top level
    // (e.g. program > expression_statement > assignment > function)
    if (!spec.nodeTypes[child.type]) {
      walkNode(child, spec, source, results, options, depth);
    }
  }
}

/** Map generic "block" kind to more specific HCL/Terraform kinds. */
function mapHclKind(kind: SymbolKind, name: string, node: Node): SymbolKind {
  if (kind !== "block") return kind;

  const parts = name.split(" ");
  const blockType = parts[0];
  switch (blockType) {
    case "resource":
      return "resource";
    case "data":
      return "data";
    case "provider":
      return "provider";
    case "output":
      return "output";
    case "variable":
      return "variable";
    case "locals":
      return "locals";
    case "module":
      return "module";
    default:
      return "block";
  }
}

function filterByKind(symbols: SymbolInfo[], kind: string): SymbolInfo[] {
  const result: SymbolInfo[] = [];
  for (const sym of symbols) {
    if (sym.kind === kind) {
      result.push(sym);
    } else if (sym.children.length > 0) {
      const filtered = filterByKind(sym.children, kind);
      if (filtered.length > 0) {
        result.push(...filtered);
      }
    }
  }
  return result;
}

function filterByName(symbols: SymbolInfo[], re: RegExp): SymbolInfo[] {
  const result: SymbolInfo[] = [];
  for (const sym of symbols) {
    if (re.test(sym.name)) {
      // Symbol matches — include it with all its children
      result.push(sym);
    } else if (sym.children.length > 0) {
      // Symbol doesn't match — but check children
      const filtered = filterByName(sym.children, re);
      if (filtered.length > 0) {
        // Include parent as container with only matching descendants
        result.push({ ...sym, children: filtered });
      }
    }
  }
  return result;
}

// ─── Formatting ─────────────────────────────────────────────────────────

const KIND_ICONS: Record<string, string> = {
  function: "fn",
  method: "method",
  class: "class",
  interface: "iface",
  type: "type",
  enum: "enum",
  struct: "struct",
  trait: "trait",
  impl: "impl",
  module: "mod",
  variable: "var",
  constant: "const",
  property: "prop",
  block: "block",
  resource: "resource",
  data: "data",
  provider: "provider",
  output: "output",
  locals: "locals",
};

/** Format symbols as a flat list. */
export function formatSymbols(symbols: SymbolInfo[], showSignatures: boolean): string {
  const lines: string[] = [];
  formatSymbolsFlat(symbols, lines, 0, showSignatures);
  return lines.join("\n");
}

function formatSymbolsFlat(
  symbols: SymbolInfo[],
  lines: string[],
  indent: number,
  showSignatures: boolean,
): void {
  for (const sym of symbols) {
    const pad = "  ".repeat(indent);
    const kindLabel = (KIND_ICONS[sym.kind] ?? sym.kind).padEnd(9);
    const lineRange =
      sym.startLine === sym.endLine ? `L${sym.startLine}` : `L${sym.startLine}-L${sym.endLine}`;
    const display = showSignatures && sym.signature ? sym.signature : sym.name;
    lines.push(`${pad}${kindLabel} ${display.padEnd(50 - indent * 2)} ${lineRange}`);
    if (sym.children.length > 0) {
      formatSymbolsFlat(sym.children, lines, indent + 1, showSignatures);
    }
  }
}

/** Format symbols as a tree outline. */
export function formatOutline(symbols: SymbolInfo[], showSignatures: boolean): string {
  const lines: string[] = [];
  formatOutlineTree(symbols, lines, "", true, showSignatures);
  return lines.join("\n");
}

function formatOutlineTree(
  symbols: SymbolInfo[],
  lines: string[],
  prefix: string,
  isRoot: boolean,
  showSignatures: boolean,
): void {
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const isLast = i === symbols.length - 1;
    const connector = isRoot ? "" : isLast ? "└── " : "├── ";
    const childPrefix = isRoot ? "" : prefix + (isLast ? "    " : "│   ");
    const kindLabel = KIND_ICONS[sym.kind] ?? sym.kind;
    const lineRange =
      sym.startLine === sym.endLine ? `L${sym.startLine}` : `L${sym.startLine}-L${sym.endLine}`;
    const display = showSignatures && sym.signature ? sym.signature : sym.name;
    lines.push(`${prefix}${connector}${display} (${kindLabel} ${lineRange})`);
    if (sym.children.length > 0) {
      formatOutlineTree(sym.children, lines, childPrefix, false, showSignatures);
    }
  }
}
