/**
 * MCP tools for WWDC session videos.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchWwdcSession, formatWwdcSessionMarkdown } from "../services/wwdc.js";
import { offsetParam, registerReadTool, render, responseFormatParam } from "./shared.js";

export function registerWwdcTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // Tool: apple_wwdc_get_session — WWDC session transcript + metadata
  // ---------------------------------------------------------------------------

  registerReadTool(
    server,
    "apple_wwdc_get_session",
    {
      title: "Get a WWDC Session Transcript",
      description: `Fetch the transcript, chapters, and code samples for a WWDC session video.

WWDC sessions are a primary source for how-and-why guidance on Apple APIs that often isn't in the reference docs. This returns the full spoken transcript plus session metadata, chapter markers, in-session code samples, and links to related sessions.

Args:
  - year (string): The 4-digit conference year, e.g. "2024".
  - session (string): The session id, e.g. "10176" (the NNN in developer.apple.com/videos/play/wwdcYYYY/NNN/).
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Find session ids by browsing developer.apple.com/videos/play/wwdc{year}/. A non-existent session returns a "not found" error.`,
      inputSchema: {
        year: z.string().min(4).max(4).describe("4-digit conference year, e.g. '2024'"),
        session: z.string().min(1).max(10).describe("Session id, e.g. '10176'"),
        response_format: responseFormatParam,
        offset: offsetParam,
      },
    },
    async ({ year, session, response_format, offset }) =>
      render(response_format, await fetchWwdcSession(year, session), formatWwdcSessionMarkdown, offset)
  );
}
