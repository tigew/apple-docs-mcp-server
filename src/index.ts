#!/usr/bin/env node
/**
 * Apple Developer Documentation MCP Server
 *
 * Provides tools to access Apple's developer documentation via their
 * public (unofficial) JSON API at:
 *   https://developer.apple.com/tutorials/data/documentation/{path}.json
 *
 * No authentication required. All documentation is publicly accessible.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppleDocsTools } from "./tools/apple-docs.js";
import { registerSwiftDocsTools } from "./tools/swift-docs.js";
import { registerWwdcTools } from "./tools/wwdc.js";
import { registerAppStoreGuidelinesTools } from "./tools/appstore-guidelines.js";
import { registerAppStoreConnectHelpTools } from "./tools/appstore-connect-help.js";
import { registerForumsTools } from "./tools/forums.js";
import { registerSupportKbTools } from "./tools/support-kb.js";
import { registerMlResearchTools } from "./tools/ml-research.js";
import { registerDeveloperNewsTools } from "./tools/developer-news.js";
import { registerTechnicalQaTools } from "./tools/technical-qa.js";

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "apple-docs-mcp-server",
  version: "1.0.0",
});

// Registration order is the order clients list the tools in.
registerAppleDocsTools(server);
registerSwiftDocsTools(server);
registerWwdcTools(server);
registerAppStoreGuidelinesTools(server);
registerAppStoreConnectHelpTools(server);
registerForumsTools(server);
registerSupportKbTools(server);
registerMlResearchTools(server);
registerDeveloperNewsTools(server);
registerTechnicalQaTools(server);

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Apple Developer Documentation MCP server running via stdio");
}

// Graceful shutdown — bounded by a timeout so a hung close() can't block
// SIGINT/SIGTERM from ever actually terminating the process.
const SHUTDOWN_TIMEOUT_MS = 2000;

async function shutdown(): Promise<void> {
  console.error("Shutting down MCP server...");
  await Promise.race([
    server.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
  ]);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error: unknown) => {
  console.error("Fatal server error:", error);
  process.exit(1);
});
