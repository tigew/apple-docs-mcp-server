/**
 * MCP tools for WWDC session videos.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  fetchWwdcSession,
  fetchWwdcSessions,
  formatWwdcSessionListMarkdown,
  formatWwdcSessionMarkdown,
} from "../services/wwdc.js";
import { offsetParam, registerReadTool, render, renderList, responseFormatParam } from "./shared.js";

export function registerWwdcTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // Tool: apple_wwdc_get_session — WWDC session transcript + metadata, and session lookup by year
  // ---------------------------------------------------------------------------

  registerReadTool(
    server,
    "apple_wwdc_get_session",
    {
      title: "Read or Find WWDC Sessions",
      description: `Read a WWDC session (transcript, chapters, code samples), or find sessions from a given year.

WWDC sessions are a primary source for how-and-why guidance on Apple APIs that often isn't in the reference docs.

Modes:
  - year + session: the full spoken transcript plus session metadata, chapter markers, in-session code samples, and links to related sessions.
  - year only: list that year's sessions (id, title, duration, topics). Add query to keep only the sessions that match it.

Args:
  - year (string): The 4-digit conference year, e.g. "2024".
  - session (string, optional): The session id, e.g. "10176" (the NNN in developer.apple.com/videos/play/wwdcYYYY/NNN/). Omit to list or search the year's sessions.
  - query (string, optional): Words to look for in session titles, topics, and descriptions when listing, e.g. "swift testing".
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

A non-existent session returns a "not found" error.`,
      inputSchema: {
        year: z.string().min(4).max(4).describe("4-digit conference year, e.g. '2024'"),
        session: z.string().max(10).optional().describe("Session id, e.g. '10176'. Omit to list the year's sessions."),
        query: z
          .string()
          .max(100)
          .optional()
          .describe("When listing: words to match against session titles, topics, and descriptions"),
        response_format: responseFormatParam,
        offset: offsetParam,
      },
    },
    async ({ year, session, query, response_format, offset }) => {
      if (session && session.trim()) {
        return render(response_format, await fetchWwdcSession(year, session.trim()), formatWwdcSessionMarkdown, offset);
      }

      const listing = await fetchWwdcSessions(year, query);
      return renderList(
        response_format,
        {
          base: {
            year: listing.year,
            ...(listing.query ? { query: listing.query } : {}),
            total: listing.total,
            count: listing.sessions.length,
          },
          key: "sessions",
          items: listing.sessions,
        },
        () => formatWwdcSessionListMarkdown(listing),
        offset
      );
    }
  );
}
