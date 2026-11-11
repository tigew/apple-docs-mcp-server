/**
 * Shared plumbing for the MCP tool modules: registration with common
 * annotations and error handling, and format-aware response rendering.
 */

import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { clampJsonList, clampJsonResponse, clampTextResponse } from "./truncation.js";

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

/** The `response_format` input every formatted tool accepts. */
export const responseFormatParam = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");

// Every tool in this server is a repeatable, read-only lookup against a public
// web source.
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** The validated arguments the SDK passes to a tool whose input schema is `Shape`. */
type ToolArgs<Shape extends z.ZodRawShape> = Parameters<ToolCallback<Shape>>[0];

/**
 * Register a read-only tool whose `body` resolves to the response text. An
 * error thrown by `body` is reported to the client as an MCP error result
 * rather than failing the request.
 */
export function registerReadTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  config: { title: string; description: string; inputSchema: Shape },
  body: (args: ToolArgs<Shape>) => Promise<string>
): void {
  const callback = async (args: ToolArgs<Shape>): Promise<CallToolResult> => {
    try {
      return { content: [{ type: "text", text: await body(args) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  };
  // The SDK's callback type is conditional on the schema, which TypeScript
  // cannot resolve while `Shape` is still generic, hence the cast. It is sound:
  // `callback` takes exactly that type's first parameter and returns its result.
  server.registerTool(
    name,
    { ...config, annotations: READ_ONLY_ANNOTATIONS },
    callback as unknown as ToolCallback<Shape>
  );
}

/** Notes appended (markdown) or embedded (JSON) when a response is cut to fit. */
interface TruncationNotes {
  json?: string;
  markdown?: string;
}

const DEFAULT_JSON_NOTE = "Response truncated.";
const DEFAULT_MARKDOWN_NOTE = "\n\n*(Response truncated.)*";

/** Render one value as JSON or markdown, kept within the response size limit. */
export function render<T>(
  format: ResponseFormat,
  value: T,
  toMarkdown: (value: T) => string,
  notes: TruncationNotes = {}
): string {
  return format === ResponseFormat.JSON
    ? clampJsonResponse(value, notes.json ?? DEFAULT_JSON_NOTE)
    : clampTextResponse(toMarkdown(value), notes.markdown ?? DEFAULT_MARKDOWN_NOTE);
}

/**
 * Render a list as JSON or markdown. JSON is `{ ...base, [key]: items }` and,
 * when too large, keeps as many whole items as fit instead of summarizing.
 */
export function renderList<T>(
  format: ResponseFormat,
  list: { base: Record<string, unknown>; key: string; items: T[] },
  toMarkdown: (items: T[]) => string,
  notes: TruncationNotes = {}
): string {
  return format === ResponseFormat.JSON
    ? clampJsonList(list.base, list.key, list.items, notes.json ?? DEFAULT_JSON_NOTE)
    : clampTextResponse(toMarkdown(list.items), notes.markdown ?? DEFAULT_MARKDOWN_NOTE);
}
