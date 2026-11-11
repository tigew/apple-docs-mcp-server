/**
 * MCP tools for the App Store Review Guidelines.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  fetchGuidelineSection,
  fetchGuidelinesIndex,
  formatGuidelineSectionMarkdown,
  formatGuidelinesIndexMarkdown,
} from "../services/appstore-guidelines.js";
import { offsetParam, registerReadTool, render, renderList, responseFormatParam } from "./shared.js";

export function registerAppStoreGuidelinesTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // Tool: apple_app_store_review_guidelines — App Store Review Guidelines
  // ---------------------------------------------------------------------------

  registerReadTool(
    server,
    "apple_app_store_review_guidelines",
    {
      title: "Get App Store Review Guidelines",
      description: `Read the App Store Review Guidelines — the rules apps must follow to pass App Review.

Call without a section to get the table of contents (all numbered sections with titles). Pass a section number to read that guideline's full text, including nested sub-points.

Args:
  - section (string, optional): A guideline number like "2", "2.3", or "2.3.1". Omit for the section index.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Examples:
  - List all sections:                 (no section)
  - Read the metadata accuracy rule:   section="2.3.1"
  - Read the whole Safety section:     section="1"`,
      inputSchema: {
        section: z
          .string()
          .max(20)
          .optional()
          .describe('Guideline number like "2.3.1". Omit to list all sections.'),
        response_format: responseFormatParam,
        offset: offsetParam,
      },
    },
    async ({ section, response_format, offset }) => {
      if (section && section.trim()) {
        return render(response_format, await fetchGuidelineSection(section.trim()), formatGuidelineSectionMarkdown, offset);
      }
      const index = await fetchGuidelinesIndex();
      return renderList(
        response_format,
        { base: { count: index.length }, key: "sections", items: index },
        formatGuidelinesIndexMarkdown,
        offset
      );
    }
  );
}
