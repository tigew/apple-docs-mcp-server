/**
 * The reference sections DocC emits for web-service and configuration
 * documentation: REST endpoints, parameters, request bodies, response codes,
 * object properties, enumeration values, property-list key details, and the
 * list of pages that mention a symbol.
 */

import {
  AppleDocContentItem,
  AppleDocFragment,
  AppleDocPage,
  AppleDocReference,
  AppleDocRestField,
  ParsedField,
  ParsedRestSections,
} from "../../types.js";
import { renderContentBlocks } from "./content.js";
import { pathFromDocUrl } from "./paths.js";

type References = Record<string, AppleDocReference> | undefined;

/** Flatten content blocks to a single line; these descriptions are almost always one paragraph. */
function describe(content: AppleDocContentItem[] | undefined, references: References): string {
  if (!content?.length) return "";
  const lines: string[] = [];
  renderContentBlocks(content, references, lines);
  return lines
    .map((line) => line.replace(/\n$/, ""))
    .join(" ")
    .trim();
}

/** A type is a token list: plain text ("[string]") and/or links to documented types. */
function describeType(tokens: AppleDocFragment[] | undefined, references: References): { type?: string; typePath?: string } {
  if (!tokens?.length) return {};
  const type = tokens.map((token) => token.text ?? "").join("").trim();
  const linked = tokens.find((token) => token.identifier);
  const typePath = linked?.identifier
    ? pathFromDocUrl(lookup(references, linked.identifier)?.url) ?? pathFromDocUrl(linked.identifier)
    : null;
  return { ...(type ? { type } : {}), ...(typePath ? { typePath } : {}) };
}

function lookup(references: References, identifier: string): AppleDocReference | undefined {
  return references && Object.prototype.hasOwnProperty.call(references, identifier) ? references[identifier] : undefined;
}

/** "maximumLength" → "Maximum length". */
function humanize(kind: string): string {
  const words = kind.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function parseField(field: AppleDocRestField, references: References): ParsedField {
  const allowedValues: string[] = [];
  const constraints: string[] = [];
  for (const attribute of field.attributes ?? []) {
    if (attribute.kind === "allowedValues" && Array.isArray(attribute.values)) {
      allowedValues.push(...attribute.values.map(String));
    } else if (attribute.value !== undefined && attribute.value !== null) {
      constraints.push(`${humanize(attribute.kind)}: ${String(attribute.value)}`);
    } else if (Array.isArray(attribute.values) && attribute.values.length > 0) {
      constraints.push(`${humanize(attribute.kind)}: ${attribute.values.map(String).join(", ")}`);
    }
  }

  return {
    name: field.name,
    ...describeType(field.type, references),
    ...(typeof field.required === "boolean" ? { required: field.required } : {}),
    description: describe(field.content, references),
    ...(allowedValues.length ? { allowedValues } : {}),
    ...(constraints.length ? { constraints } : {}),
    ...(field.deprecated ? { deprecated: true } : {}),
  };
}

const parseFields = (fields: AppleDocRestField[] | undefined, references: References): ParsedField[] =>
  (fields ?? []).filter((field) => field?.name).map((field) => parseField(field, references));

/**
 * Extract every reference section present on a page. Fields are only set when
 * the page actually has that section, so ordinary symbol and article pages are
 * unaffected.
 */
export function extractRestSections(page: AppleDocPage): ParsedRestSections {
  const sections = page.primaryContentSections ?? [];
  const references = page.references;
  const out: ParsedRestSections = {};

  for (const section of sections) {
    switch (section.kind) {
      case "restEndpoint": {
        const tokens = section.tokens ?? [];
        const method = tokens.find((token) => token.kind === "method")?.text ?? "";
        const url = tokens
          .filter((token) => token.kind !== "method")
          .map((token) => token.text ?? "")
          .join("")
          .trim();
        if (url) (out.restEndpoints ??= []).push({ title: section.title ?? "URL", method, url });
        break;
      }
      case "restParameters": {
        const items = parseFields(section.items, references);
        if (items.length) {
          (out.restParameters ??= []).push({ title: section.title ?? "Parameters", source: section.source ?? "", items });
        }
        break;
      }
      case "restBody": {
        // A body's own `parameters` (multipart form fields) share the field shape.
        const parameters = parseFields(section.parameters as AppleDocRestField[] | undefined, references);
        out.restBody = {
          title: section.title ?? "HTTP Body",
          ...(section.mimeType ? { mimeType: section.mimeType } : {}),
          ...describeType(section.bodyContentType, references),
          description: describe(section.content, references),
          ...(parameters.length ? { parameters } : {}),
        };
        break;
      }
      case "restResponses": {
        const responses = (section.items ?? []).map((item) => ({
          status: Number(item.status),
          ...(item.reason ? { reason: item.reason } : {}),
          ...(item.mimeType ? { mimeType: item.mimeType } : {}),
          ...describeType(item.type, references),
          description: describe(item.content, references),
        }));
        if (responses.length) out.restResponses = responses;
        break;
      }
      case "properties": {
        const items = parseFields(section.items, references);
        if (items.length) out.properties = { title: section.title ?? "Properties", items };
        break;
      }
      case "possibleValues": {
        const items = parseFields(section.values, references);
        if (items.length) out.possibleValues = { title: section.title ?? "Possible Values", items };
        break;
      }
      case "details": {
        const details = section.details;
        if (details?.name) {
          out.details = {
            name: details.name,
            ...(details.ideTitle ? { ideTitle: details.ideTitle } : {}),
            valueTypes: (details.value ?? [])
              .filter((value) => value?.baseType)
              .map((value) => (value.arrayMode ? `[${value.baseType}]` : String(value.baseType))),
          };
        }
        break;
      }
      case "mentions": {
        const mentionedIn = (section.mentions ?? [])
          .map((identifier) => {
            const reference = lookup(references, identifier);
            const path = pathFromDocUrl(reference?.url) ?? pathFromDocUrl(identifier);
            return path ? { title: reference?.title ?? path.split("/").pop() ?? path, path } : null;
          })
          .filter((entry): entry is { title: string; path: string } => entry !== null);
        if (mentionedIn.length) out.mentionedIn = mentionedIn;
        break;
      }
    }
  }

  return out;
}
