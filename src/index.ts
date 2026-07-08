#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SessionManager } from "./sessions.js";
import { registerTools } from "./tools.js";

const server = new McpServer({
  name: "mcp-evidence",
  version: "0.1.0",
});

const sessions = new SessionManager();
registerTools(server, sessions);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`Received ${signal}, flushing open evidence sessions...`);
  await sessions.shutdown();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-evidence server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error starting mcp-evidence server:", error);
  process.exit(1);
});
