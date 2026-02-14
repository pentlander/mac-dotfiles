/**
 * Thin wrapper around @modelcontextprotocol/sdk SSE client,
 * with project path discovery.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

export type McpClient = Client;

export interface IdeConnection {
  url: string;
  client: McpClient;
  serverName: string;
  serverVersion: string;
  projectPaths: string[];
}

export async function connectToIde(sseUrl: string): Promise<IdeConnection> {
  const transport = new SSEClientTransport(new URL(sseUrl));
  const client = new Client(
    { name: "pi-jetbrains-bridge", version: "0.1.0" },
    { capabilities: {} }
  );
  await client.connect(transport);

  const serverInfo = client.getServerVersion();
  const serverName = serverInfo?.name ?? "Unknown";
  const serverVersion = serverInfo?.version ?? "?";

  const projectPaths = await discoverProjects(client);

  return { url: sseUrl, client, serverName, serverVersion, projectPaths };
}

async function discoverProjects(client: McpClient): Promise<string[]> {
  const result = await client.callTool({
    name: "get_all_open_file_paths",
    arguments: { projectPath: "/__pi_discovery__" },
  });

  if (!("content" in result)) return [];
  const text = result.content
    .map((c) => ("text" in c ? c.text : ""))
    .join("");

  const match = text.match(/\{"projects":\[.*?\]\}/);
  if (match) {
    try {
      const data = JSON.parse(match[0]) as { projects: Array<{ path: string }> };
      return data.projects.map((p) => p.path);
    } catch {}
  }

  try {
    const data = JSON.parse(text) as { activeFilePath?: string };
    if (data.activeFilePath) {
      return [];
    }
  } catch {}

  return [];
}

