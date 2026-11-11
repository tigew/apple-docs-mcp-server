/**
 * MCP tools for Apple Developer News and marketing microsites.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  fetchMarketingPage,
  fetchNewsList,
  fetchNewsPost,
  formatMarketingPageMarkdown,
  formatNewsListMarkdown,
  formatNewsPostMarkdown,
} from "../services/developer-news.js";
import { registerReadTool, render, renderList, responseFormatParam } from "./shared.js";

export function registerDeveloperNewsTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // Tool: apple_developer_news — Developer News + marketing microsite reader
  // ---------------------------------------------------------------------------

  registerReadTool(
    server,
    "apple_developer_news",
    {
      title: "Read Apple Developer News",
      description: `Read Apple Developer News posts (announcements: policy changes, SDK releases, deadlines) — and, best-effort, the developer marketing/topic microsites.

Modes:
  - No arguments: list recent developer news posts.
  - id: read a single news post by its id (the ?id= value on developer.apple.com/news/).
  - page: best-effort readable extraction of a developer.apple.com marketing microsite (e.g. "apple-intelligence", "private-cloud-compute"). These pages have no structured schema, so extraction is lossy and clearly labeled.

Args:
  - id (string, optional): A news post id like "tlur8uvi".
  - page (string, optional): A marketing microsite slug like "apple-intelligence".
  - limit (number): Max posts when listing, 1–50 (default: 15)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: {
        id: z.string().max(32).optional().describe('News post id like "tlur8uvi"'),
        page: z.string().max(120).optional().describe('Marketing microsite slug like "apple-intelligence"'),
        limit: z.number().int().min(1).max(50).default(15).describe("Max posts when listing (default: 15)"),
        response_format: responseFormatParam,
      },
    },
    async ({ id, page, limit, response_format }) => {
      if (page && page.trim()) {
        return render(response_format, await fetchMarketingPage(page.trim()), formatMarketingPageMarkdown);
      }
      if (id && id.trim()) {
        return render(response_format, await fetchNewsPost(id.trim()), formatNewsPostMarkdown);
      }
      const list = await fetchNewsList(limit);
      return renderList(
        response_format,
        { base: { count: list.length }, key: "posts", items: list },
        formatNewsListMarkdown
      );
    }
  );
}
