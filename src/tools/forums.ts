/**
 * MCP tools for Apple Developer Forums listings.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchForumThreads, formatForumThreadsMarkdown } from "../services/forums.js";
import { offsetParam, registerReadTool, renderList, responseFormatParam } from "./shared.js";

export function registerForumsTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // Tool: apple_forums_list_threads — Apple Developer Forums (listings only)
  // ---------------------------------------------------------------------------

  registerReadTool(
    server,
    "apple_forums_list_threads",
    {
      title: "List Apple Developer Forums Threads",
      description: `List recent Apple Developer Forums thread titles, IDs, and links — optionally filtered by tag.

IMPORTANT LIMITATION: this returns thread *titles and links only*. Apple gates individual thread pages behind a JavaScript bot-challenge, so thread bodies and replies cannot be fetched automatically — open a returned URL in a browser to read the discussion. This is a discovery aid (what's being discussed, and where), not full-text forum search.

Args:
  - tag (string, optional): A forum tag slug to filter by, e.g. "swiftui", "app-store-connect", "widgetkit". Omit for recent threads across all tags.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: {
        tag: z
          .string()
          .max(60)
          .optional()
          .describe('Forum tag slug like "swiftui". Omit for recent threads across all tags.'),
        response_format: responseFormatParam,
        offset: offsetParam,
      },
    },
    async ({ tag, response_format, offset }) => {
      const { tag: resolvedTag, threads } = await fetchForumThreads(tag?.trim() || undefined);
      return renderList(
        response_format,
        {
          base: {
            tag: resolvedTag,
            count: threads.length,
            note: "Thread bodies are not available (bot-challenge gated); titles and links only.",
          },
          key: "threads",
          items: threads,
        },
        (items) => formatForumThreadsMarkdown(resolvedTag, items),
        offset
      );
    }
  );
}
