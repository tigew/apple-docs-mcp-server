/**
 * MCP tools for swift.org (The Swift Programming Language, release notes).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatDocPageMarkdown } from "../services/apple-docs.js";
import {
  fetchSwiftBookPage,
  fetchSwiftReleaseNotes,
  formatSwiftReleaseNotesMarkdown,
} from "../services/swift-docs.js";
import { registerReadTool, render, renderList, responseFormatParam } from "./shared.js";

export function registerSwiftDocsTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // Tool: apple_swift_book_get_page — "The Swift Programming Language" (swift.org)
  // ---------------------------------------------------------------------------

  registerReadTool(
    server,
    "apple_swift_book_get_page",
    {
      title: "Get a Page from The Swift Programming Language",
      description: `Fetch a chapter or section from "The Swift Programming Language" (TSPL) book, published at docs.swift.org.

This is the authoritative reference for Swift-the-language concepts (syntax, types, generics, concurrency, macros, memory model), which the framework docs at developer.apple.com explicitly defer to but do not contain. Use this when a question is about the language itself rather than a specific framework's API.

Args:
  - path (string): A book path. Accepts the book root ("the-swift-programming-language"), a qualified path ("the-swift-programming-language/thebasics"), or a bare chapter slug ("thebasics", "concurrency", "macros", "generics", "accesscontrol"). Case-insensitive.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns the chapter's prose, code listings, and links to sub-topics (paths usable as input to this tool). Start with path="the-swift-programming-language" to see the table of contents.`,
      inputSchema: {
        path: z
          .string()
          .min(1, "Path must not be empty")
          .max(300, "Path is too long")
          .describe("Book path or chapter slug, e.g. 'the-swift-programming-language', 'thebasics', 'concurrency'"),
        response_format: responseFormatParam,
      },
    },
    async ({ path, response_format }) =>
      render(response_format, await fetchSwiftBookPage(path), formatDocPageMarkdown, {
        json: "Response truncated. Use a more specific chapter path.",
        markdown: "\n\n*(Response truncated. Use a more specific chapter path.)*",
      })
  );

  // ---------------------------------------------------------------------------
  // Tool: apple_swift_get_release_notes — Swift release notes / "What's new"
  // ---------------------------------------------------------------------------

  registerReadTool(
    server,
    "apple_swift_get_release_notes",
    {
      title: "Get Swift Release Notes and Updates",
      description: `List recent Swift release notes and "What's new in Swift" updates from swift.org and the swiftlang/swift release feed.

Use this for modern Swift-the-language release information (new language features, toolchain snapshots), which is published at swift.org — a different origin from developer.apple.com, so it does not appear in the framework docs or Xcode release notes.

Args:
  - limit (number): Maximum entries to return, 1–25 (default: 10)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns entries with title, date, source, link, and a short summary, newest first.`,
      inputSchema: {
        limit: z.number().int().min(1).max(25).default(10).describe("Maximum number of entries (default: 10)"),
        response_format: responseFormatParam,
      },
    },
    async ({ limit, response_format }) => {
      const entries = await fetchSwiftReleaseNotes(limit);
      return renderList(
        response_format,
        { base: { count: entries.length }, key: "entries", items: entries },
        formatSwiftReleaseNotesMarkdown,
        { markdown: "\n\n*(Response truncated — reduce limit.)*" }
      );
    }
  );
}
