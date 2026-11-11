/**
 * MCP tools for App Store Connect Help and TestFlight.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  fetchHelpArticle,
  fetchHelpIndex,
  formatHelpArticleMarkdown,
  formatHelpIndexMarkdown,
} from "../services/appstore-connect-help.js";
import { registerReadTool, render, renderList, responseFormatParam } from "./shared.js";

export function registerAppStoreConnectHelpTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // Tool: apple_app_store_connect_help — App Store Connect Help + TestFlight
  // ---------------------------------------------------------------------------

  registerReadTool(
    server,
    "apple_app_store_connect_help",
    {
      title: "Get App Store Connect Help Article",
      description: `Read App Store Connect Help center articles and the TestFlight product page — the how-to walkthroughs for managing apps, builds, testers, subscriptions, and Game Center in App Store Connect.

This is distinct from the App Store Connect REST API docs (use apple_docs_get_page with path "appstoreconnectapi" for those). Call without a path to list available help articles; pass a path to read one.

Args:
  - path (string, optional): An article path like "help/app-store-connect/test-a-beta-version/testflight-overview", or the exact value "testflight" for the TestFlight product page. Omit for the article index.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: {
        path: z
          .string()
          .max(300)
          .optional()
          .describe('Help article path or "testflight". Omit to list available articles.'),
        response_format: responseFormatParam,
      },
    },
    async ({ path, response_format }) => {
      if (path && path.trim()) {
        return render(response_format, await fetchHelpArticle(path.trim()), formatHelpArticleMarkdown, {
          json: "Response truncated. The article may be long.",
        });
      }
      const index = await fetchHelpIndex();
      return renderList(
        response_format,
        { base: { count: index.length }, key: "articles", items: index },
        formatHelpIndexMarkdown
      );
    }
  );
}
