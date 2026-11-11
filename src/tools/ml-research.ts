/**
 * MCP tools for Apple Machine Learning Research.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  fetchMlResearchList,
  fetchMlResearchPost,
  formatMlResearchListMarkdown,
  formatMlResearchPostMarkdown,
} from "../services/ml-research.js";
import { registerReadTool, render, renderList, responseFormatParam } from "./shared.js";

export function registerMlResearchTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // Tool: apple_ml_research — machinelearning.apple.com research posts
  // ---------------------------------------------------------------------------

  registerReadTool(
    server,
    "apple_ml_research",
    {
      title: "Browse Apple Machine Learning Research",
      description: `Browse or read Apple's first-party Machine Learning Research posts from machinelearning.apple.com.

Call without a slug to list recent research posts; pass a slug to read one (title, authors, date, abstract/body, tags, and external links such as arXiv).

Args:
  - slug (string, optional): A post slug like "environment-free". Omit to list recent posts.
  - limit (number): Max posts when listing, 1–50 (default: 15)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: {
        slug: z.string().max(200).optional().describe('Post slug like "environment-free". Omit to list recent posts.'),
        limit: z.number().int().min(1).max(50).default(15).describe("Max posts when listing (default: 15)"),
        response_format: responseFormatParam,
      },
    },
    async ({ slug, limit, response_format }) => {
      if (slug && slug.trim()) {
        return render(response_format, await fetchMlResearchPost(slug.trim()), formatMlResearchPostMarkdown);
      }
      const list = await fetchMlResearchList(limit);
      return renderList(
        response_format,
        { base: { count: list.length }, key: "posts", items: list },
        formatMlResearchListMarkdown
      );
    }
  );
}
