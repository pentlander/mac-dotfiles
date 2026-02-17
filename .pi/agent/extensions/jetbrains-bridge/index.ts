/**
 * JetBrains IDE Bridge for pi
 *
 * Connects to running JetBrains IDEs via their MCP servers (SSE) and exposes
 * IDE intelligence as pi tools with minimal token overhead. Automatically
 * routes tool calls to the correct IDE based on working directory.
 *
 * Tools:
 *   jb_symbol   - Get symbol info (definition location, type signature, docs)
 *   jb_rename   - Semantic rename across project
 *   jb_problems - Get file errors/warnings from IDE inspections
 *
 * Commands:
 *   /jb             - Show connected IDEs and their projects
 *   /jb add <url>   - Add an IDE endpoint
 *   /jb remove <url> - Remove an IDE endpoint
 *   /jb scan        - Scan common ports for running IDEs
 *
 * Configure via:
 *   ~/.pi/agent/extensions/jetbrains-bridge/ides.json
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes, Root } from "mdast";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { connectToIde, type IdeConnection, type McpClient } from "./mcp-client.ts";

// --- Config ---

interface Config {
  urls: string[];
}

const CONFIG_PATH = resolve(dirname(new URL(import.meta.url).pathname), "ides.json");

function loadConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Config;
  } catch {
    return { urls: [] };
  }
}

function saveConfig(config: Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

// --- MCP result helpers ---

type McpResult = Awaited<ReturnType<McpClient["callTool"]>>;

function resultText(result: McpResult): string {
  if (!("content" in result)) return "";
  return result.content
    .map((c) => ("text" in c ? c.text : ""))
    .join("\n");
}

interface SymbolInfoResponse {
  symbolInfo?: {
    name: string;
    declarationFile: string;
    declarationLine?: number;
    declarationText?: string;
    language?: string;
  };
  documentation?: string;
}

function structured(result: McpResult): SymbolInfoResponse | null {
  if ("structuredContent" in result && result.structuredContent) {
    return result.structuredContent as SymbolInfoResponse;
  }
  if ("content" in result && result.content[0] && "text" in result.content[0]) {
    try {
      return JSON.parse(result.content[0].text) as SymbolInfoResponse;
    } catch {}
  }
  return null;
}

function isError(result: McpResult): boolean {
  return "isError" in result && result.isError === true;
}

// --- Documentation parsing (language-agnostic) ---

interface ParsedSymbolResult {
  definition?: string;
  type?: string;
  docs?: string;
}

function extractText(node: Nodes | Root): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
      return node.value;
    case "link":
      return node.children.map(extractText).join("");
    default:
      if ("children" in node) {
        return (node.children as Nodes[]).map(extractText).join("");
      }
      return "";
  }
}

function cleanJbDoc(raw: string): string {
  const fixed = raw.replace(/\[\n```\n([^\n]+)\n```\n\]/g, "[$1]");
  const tree = fromMarkdown(fixed);
  return tree.children.map(extractText).join("\n\n").trim();
}

function parseSymbolResult(data: SymbolInfoResponse): ParsedSymbolResult {
  const result: ParsedSymbolResult = {};
  const info = data.symbolInfo;

  if (info?.declarationFile) {
    result.definition = info.declarationLine
      ? `${info.declarationFile}:${info.declarationLine}`
      : info.declarationFile;
  }

  if (data.documentation) {
    const cleaned = cleanJbDoc(data.documentation);
    const lines = cleaned.split("\n");

    const sigLines: string[] = [];
    let docStartIdx = -1;

    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) {
        docStartIdx = lines.findIndex((x, j) => j > i && x.trim() !== "");
        break;
      }
      sigLines.push(lines[i]);
    }

    if (sigLines.length > 0) {
      result.type = sigLines.join("\n");
    }

    if (docStartIdx > 0) {
      const docText = lines.slice(docStartIdx).join("\n").trim();
      if (docText) result.docs = docText;
    }
  }

  return result;
}

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (first && first.type === "text" && first.text) return first.text;
  return "";
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  const connections: IdeConnection[] = [];

  /**
   * Find the best IDE connection for a given working directory.
   * Uses longest-prefix matching on project paths.
   */
  function findConnection(cwd: string): { conn: IdeConnection; projectPath: string } | null {
    let best: { conn: IdeConnection; projectPath: string } | null = null;
    let bestLen = 0;

    for (const conn of connections) {
      for (const projPath of conn.projectPaths) {
        if (cwd.startsWith(projPath) && projPath.length > bestLen) {
          best = { conn, projectPath: projPath };
          bestLen = projPath.length;
        }
      }
    }

    // Fallback: if only one connection, use it
    if (!best && connections.length === 1) {
      const conn = connections[0];
      const projectPath = conn.projectPaths[0] ?? cwd;
      return { conn, projectPath };
    }

    return best;
  }

  async function connectUrl(url: string): Promise<IdeConnection | null> {
    // Don't double-connect
    const existing = connections.find((c) => c.url === url);
    if (existing) return existing;

    try {
      const conn = await connectToIde(url);
      connections.push(conn);
      return conn;
    } catch {
      return null;
    }
  }

  async function disconnectUrl(url: string): Promise<boolean> {
    const idx = connections.findIndex((c) => c.url === url);
    if (idx === -1) return false;
    const conn = connections[idx];
    await conn.client.close();
    connections.splice(idx, 1);
    return true;
  }

  async function connectAll(): Promise<void> {
    const config = loadConfig();
    await Promise.all(config.urls.map((url) => connectUrl(url)));
    updateStatus();
  }

  function updateStatus(): void {
    if (connections.length === 0) {
      pi.events.emit("jb:status", "JB ✗");
    } else {
      const names = connections.map((c) => c.serverName.replace(/ MCP Server$/, ""));
      pi.events.emit("jb:status", `JB: ${names.join(", ")}`);
    }
  }

  // Listen for status updates (set in session_start handler where we have ctx)
  let setStatus: ((text: string) => void) | null = null;
  pi.events.on("jb:status", (text: string) => {
    setStatus?.(text);
  });

  // --- /jb command ---
  pi.registerCommand("jb", {
    description: "Manage JetBrains IDE connections",
    getArgumentCompletions: (prefix: string) => {
      const cmds = ["add", "remove", "scan"];
      return cmds
        .filter((c) => c.startsWith(prefix))
        .map((c) => ({ value: c, label: c }));
    },
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const subcommand = parts[0] ?? "";

      if (subcommand === "add") {
        const url = parts[1];
        if (!url) {
          ctx.ui.notify("Usage: /jb add <url>", "error");
          return;
        }
        ctx.ui.notify(`Connecting to ${url}...`, "info");
        const conn = await connectUrl(url);
        if (conn) {
          const config = loadConfig();
          if (!config.urls.includes(url)) {
            config.urls.push(url);
            saveConfig(config);
          }
          const projects = conn.projectPaths.join(", ") || "(unknown)";
          ctx.ui.notify(`Connected: ${conn.serverName} v${conn.serverVersion} — projects: ${projects}`, "info");
          updateStatus();
        } else {
          ctx.ui.notify(`Failed to connect to ${url}`, "error");
        }
        return;
      }

      if (subcommand === "remove") {
        const url = parts[1];
        if (!url) {
          ctx.ui.notify("Usage: /jb remove <url>", "error");
          return;
        }
        await disconnectUrl(url);
        const config = loadConfig();
        config.urls = config.urls.filter((u) => u !== url);
        saveConfig(config);
        ctx.ui.notify(`Removed ${url}`, "info");
        updateStatus();
        return;
      }

      if (subcommand === "scan") {
        ctx.ui.notify("Scanning ports 63342-64400...", "info");
        let found = 0;
        const config = loadConfig();

        const scanPromises = [];
        for (let port = 63342; port <= 64400; port++) {
          const url = `http://127.0.0.1:${port}/sse`;
          if (connections.some((c) => c.url === url)) continue;
          scanPromises.push(
            (async () => {
              const conn = await connectUrl(url);
              if (conn) {
                found++;
                if (!config.urls.includes(url)) {
                  config.urls.push(url);
                }
                const projects = conn.projectPaths.join(", ") || "(unknown)";
                ctx.ui.notify(
                  `Found: ${conn.serverName} v${conn.serverVersion} at ${url} — projects: ${projects}`,
                  "info"
                );
              }
            })()
          );
        }
        await Promise.all(scanPromises);

        if (found > 0) {
          saveConfig(config);
          updateStatus();
          ctx.ui.notify(`Scan complete. Found ${found} new IDE(s).`, "info");
        } else {
          ctx.ui.notify("Scan complete. No new IDEs found.", "info");
        }
        return;
      }

      // Default: show status
      if (connections.length === 0) {
        ctx.ui.notify(
          "No JetBrains IDEs connected.\nUse /jb add <url> or /jb scan to find running IDEs.",
          "info"
        );
        return;
      }

      const lines = connections.map((c) => {
        const projects = c.projectPaths.length > 0
          ? c.projectPaths.map((p) => `  ${p}`).join("\n")
          : "  (unknown)";
        return `${c.serverName} v${c.serverVersion}\n  ${c.url}\n${projects}`;
      });
      ctx.ui.notify(lines.join("\n\n"), "info");
    },
  });

  // --- jb_symbol ---
  pi.registerTool({
    name: "jb_symbol",
    label: "JB Symbol",
    description:
      'Get symbol information from JetBrains IDE at a file position. Use this to jump to definitions when tracing through code — when you see a method call, variable, or type and need to find where it\'s defined, use this instead of searching. Returns definition location and type signature by default. Add "docs" to include for full documentation (verbose).',
    parameters: Type.Object({
      file: Type.String({ description: "File path relative to project root" }),
      line: Type.Number({ description: "1-based line number" }),
      column: Type.Number({ description: "1-based column number" }),
      include: Type.Optional(
        Type.Array(StringEnum(["definition", "type", "docs"] as const), {
          description:
            'What to include. Defaults to ["definition", "type"]. Add "docs" for full documentation.',
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const include = new Set(params.include ?? ["definition", "type"]);
      const match = findConnection(ctx.cwd);

      if (!match) {
        return {
          content: [{ type: "text", text: "No JetBrains IDE connected for this project. Use /jb scan or /jb add <url>." }],
          isError: true,
          details: {},
        };
      }

      try {
        const result = await match.conn.client.callTool({
          name: "get_symbol_info",
          arguments: {
            filePath: params.file,
            line: params.line,
            column: params.column,
            projectPath: match.projectPath,
          },
        });

        if (isError(result)) {
          return {
            content: [{ type: "text", text: `Error: ${resultText(result)}` }],
            isError: true,
            details: {},
          };
        }

        const data = structured(result);
        if (!data) {
          return {
            content: [{ type: "text", text: "No response from IDE." }],
            isError: true,
            details: {},
          };
        }

        const parsed = parseSymbolResult(data);
        const parts: string[] = [];

        if (include.has("definition") && parsed.definition) {
          parts.push(`Definition: ${parsed.definition}`);
        }
        if (include.has("type") && parsed.type) {
          parts.push(`Type: ${parsed.type}`);
        }
        if (include.has("docs") && parsed.docs) {
          parts.push(`Docs: ${parsed.docs}`);
        }

        if (parts.length === 0) {
          parts.push("No symbol information found at this position.");
        }

        return {
          content: [{ type: "text", text: parts.join("\n") }],
          details: { parsed, include: Array.from(include) },
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `JetBrains connection error: ${msg}` }],
          isError: true,
          details: {},
        };
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("jb_symbol "));
      text += theme.fg("accent", `${args.file}:${args.line}:${args.column}`);
      if (args.include) {
        text += theme.fg("dim", ` [${(args.include as string[]).join(", ")}]`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      if (result.isError) {
        return new Text(theme.fg("error", getResultText(result) || "Error"), 0, 0);
      }
      const content = getResultText(result);
      const lines = content.split("\n");
      if (!expanded && lines.length > 3) {
        return new Text(lines.slice(0, 3).join("\n") + theme.fg("dim", "\n…"), 0, 0);
      }
      return new Text(content, 0, 0);
    },
  });

  // --- jb_rename ---
  pi.registerTool({
    name: "jb_rename",
    label: "JB Rename",
    description:
      "Semantic rename of a symbol across the entire project using JetBrains IDE. Updates all references, unlike text find/replace.",
    parameters: Type.Object({
      file: Type.String({ description: "File path relative to project root containing the symbol" }),
      symbol: Type.String({ description: "Current name of the symbol to rename" }),
      newName: Type.String({ description: "New name for the symbol" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const match = findConnection(ctx.cwd);
      if (!match) {
        return {
          content: [{ type: "text", text: "No JetBrains IDE connected for this project. Use /jb scan or /jb add <url>." }],
          isError: true,
          details: {},
        };
      }

      try {
        const result = await match.conn.client.callTool({
          name: "rename_refactoring",
          arguments: {
            pathInProject: params.file,
            symbolName: params.symbol,
            newName: params.newName,
            projectPath: match.projectPath,
          },
        });

        return {
          content: [{ type: "text", text: resultText(result) }],
          isError: isError(result),
          details: {},
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `JetBrains connection error: ${msg}` }],
          isError: true,
          details: {},
        };
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("jb_rename "));
      text += theme.fg("accent", args.symbol);
      text += theme.fg("muted", " → ");
      text += theme.fg("success", args.newName);
      text += theme.fg("dim", ` in ${args.file}`);
      return new Text(text, 0, 0);
    },
  });

  // --- jb_problems ---
  pi.registerTool({
    name: "jb_problems",
    label: "JB Problems",
    description:
      "Get errors and warnings for a file from JetBrains IDE inspections. More accurate than compiler output alone.",
    parameters: Type.Object({
      file: Type.String({ description: "File path relative to project root" }),
      errorsOnly: Type.Optional(
        Type.Boolean({ description: "Only return errors, not warnings. Default: false." })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const match = findConnection(ctx.cwd);
      if (!match) {
        return {
          content: [{ type: "text", text: "No JetBrains IDE connected for this project. Use /jb scan or /jb add <url>." }],
          isError: true,
          details: {},
        };
      }

      try {
        const result = await match.conn.client.callTool({
          name: "get_file_problems",
          arguments: {
            filePath: params.file,
            errorsOnly: params.errorsOnly ?? false,
            projectPath: match.projectPath,
          },
        });

        const rawText = resultText(result);
        const truncation = truncateHead(rawText, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });

        let text = truncation.content;
        if (truncation.truncated) {
          text += `\n[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
        }

        return {
          content: [{ type: "text", text }],
          isError: isError(result),
          details: { truncated: truncation.truncated },
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `JetBrains connection error: ${msg}` }],
          isError: true,
          details: {},
        };
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("jb_problems "));
      text += theme.fg("accent", args.file);
      if (args.errorsOnly) text += theme.fg("dim", " (errors only)");
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      if (result.isError) {
        return new Text(theme.fg("error", getResultText(result) || "Error"), 0, 0);
      }
      const content = getResultText(result);
      if (!content.trim() || content.includes("[]")) {
        return new Text(theme.fg("success", "No problems found"), 0, 0);
      }
      const lines = content.split("\n");
      if (!expanded && lines.length > 5) {
        return new Text(
          lines.slice(0, 5).join("\n") + theme.fg("dim", `\n… ${lines.length - 5} more`),
          0,
          0
        );
      }
      return new Text(content, 0, 0);
    },
  });

  // --- jb_open ---
  pi.registerTool({
    name: "jb_open",
    label: "JB Open",
    description:
      "Open a file in the JetBrains IDE editor.",
    parameters: Type.Object({
      file: Type.String({ description: "File path relative to project root" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const match = findConnection(ctx.cwd);
      if (!match) {
        return {
          content: [{ type: "text", text: "No JetBrains IDE connected for this project. Use /jb scan or /jb add <url>." }],
          isError: true,
          details: {},
        };
      }

      try {
        const result = await match.conn.client.callTool({
          name: "open_file_in_editor",
          arguments: {
            filePath: params.file,
            projectPath: match.projectPath,
          },
        });

        return {
          content: [{ type: "text", text: resultText(result) }],
          isError: isError(result),
          details: {},
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `JetBrains connection error: ${msg}` }],
          isError: true,
          details: {},
        };
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("jb_open "));
      text += theme.fg("accent", args.file);
      return new Text(text, 0, 0);
    },
  });

  // --- Active file context ---

  interface OpenFilesResponse {
    activeFilePath?: string | null;
    openFiles?: string[];
  }

  async function getActiveFile(cwd: string): Promise<string | null> {
    const match = findConnection(cwd);
    if (!match) return null;

    try {
      const result = await match.conn.client.callTool({
        name: "get_all_open_file_paths",
        arguments: { projectPath: match.projectPath },
      });

      const data = ("structuredContent" in result && result.structuredContent)
        ? result.structuredContent as OpenFilesResponse
        : null;

      if (!data) {
        // Try parsing from text content
        if ("content" in result && result.content[0] && "text" in result.content[0]) {
          try {
            const parsed = JSON.parse(result.content[0].text) as OpenFilesResponse;
            return parsed.activeFilePath ?? null;
          } catch {}
        }
        return null;
      }

      return data.activeFilePath ?? null;
    } catch {
      return null;
    }
  }

  pi.on("before_agent_start", async (event, ctx) => {
    if (connections.length === 0) return;

    const activeFile = await getActiveFile(ctx.cwd);
    if (!activeFile) return;

    const match = findConnection(ctx.cwd);
    const ideName = match?.conn.serverName.replace(/ MCP Server$/, "") ?? "IDE";

    return {
      message: {
        customType: "jb-context",
        content: `[JetBrains ${ideName}] Active file: ${activeFile}`,
        display: false,
      },
    };
  });

  // --- Lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    setStatus = (text: string) => ctx.ui.setStatus("jb", text);
    await connectAll();
  });

  pi.on("session_shutdown", async () => {
    for (const conn of connections) {
      await conn.client.close();
    }
    connections.length = 0;
  });
}
