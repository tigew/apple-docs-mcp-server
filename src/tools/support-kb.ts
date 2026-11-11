/**
 * MCP tools for support.apple.com Knowledge Base articles.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchSupportArticle, formatSupportArticleMarkdown } from "../services/support-kb.js";
import { registerReadTool, render, responseFormatParam } from "./shared.js";

export function registerSupportKbTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // Tool: apple_support_article — support.apple.com consumer Knowledge Base
  // ---------------------------------------------------------------------------

  registerReadTool(
    server,
    "apple_support_article",
    {
      title: "Get an Apple Support (Knowledge Base) Article",
      description: `Fetch a support.apple.com Knowledge Base article by id — the authoritative consumer-facing source for device/feature eligibility lists, compatibility tables, and how-to steps.

Args:
  - id (string): The article id — a modern numeric id ("108351", "102651") or a legacy HT id ("HT201260", auto-resolved to its numeric replacement).
  - locale (string, optional): Locale segment like "en-us" (default) or "de-de".
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns the article title, summary, and body (including eligibility lists/tables). This is Apple's consumer support site, distinct from developer documentation.`,
      inputSchema: {
        id: z.string().min(1).max(20).describe('Article id, e.g. "108351" or "HT201260"'),
        locale: z.string().max(10).optional().describe('Locale like "en-us" (default) or "de-de"'),
        response_format: responseFormatParam,
      },
    },
    async ({ id, locale, response_format }) =>
      render(response_format, await fetchSupportArticle(id, locale), formatSupportArticleMarkdown, {
        json: "Response truncated. The article may be long.",
      })
  );
}
