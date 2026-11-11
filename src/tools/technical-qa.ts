/**
 * MCP tools for the archived Technical Q&A library.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchTechnicalQa, formatTechnicalQaMarkdown } from "../services/technical-qa.js";
import { offsetParam, registerReadTool, render, responseFormatParam } from "./shared.js";

export function registerTechnicalQaTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // Tool: apple_technical_qa — legacy Technical Q&A archive
  // ---------------------------------------------------------------------------

  registerReadTool(
    server,
    "apple_technical_qa",
    {
      title: "Get a Legacy Apple Technical Q&A",
      description: `Fetch an archived Apple Technical Q&A (developer.apple.com/library/archive/qa/*) by id.

This is superseded/archived content (each page carries a "no longer updated" banner), but individual Q&As are still referenced for specific low-level techniques. There is no listing (the id space is sparse), so you need a specific id.

Args:
  - id (string): A Technical Q&A id like "qa1361".
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: {
        id: z.string().min(1).max(20).describe('Technical Q&A id like "qa1361"'),
        response_format: responseFormatParam,
        offset: offsetParam,
      },
    },
    async ({ id, response_format, offset }) =>
      render(response_format, await fetchTechnicalQa(id), formatTechnicalQaMarkdown, offset)
  );
}
