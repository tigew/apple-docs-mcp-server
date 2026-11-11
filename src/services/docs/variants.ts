/**
 * Language variants of a documentation page. Apple serves one JSON document
 * per page (the Swift rendition for most symbols) and ships any other
 * rendition as a JSON Patch to apply on top of it.
 */

import { AppleDocPage, JsonPatchOperation } from "../../types.js";

// Keys a patch must never be allowed to walk through or assign: the patch is
// remote data, and these would let it alter object prototypes.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type Container = Record<string, unknown> | unknown[];

function isContainer(value: unknown): value is Container {
  return typeof value === "object" && value !== null;
}

/** Split a JSON Pointer (RFC 6901) into its unescaped reference tokens. */
function pointerTokens(pointer: string): string[] {
  return pointer
    .split("/")
    .slice(1)
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * Apply a JSON Patch (RFC 6902) and return the result; the input is not
 * modified. Supports the operations Apple's variant overrides use — `replace`,
 * `add`, and `remove`. An operation whose path does not exist in the document
 * is skipped rather than failing the whole page.
 */
export function applyJsonPatch<T>(document: T, operations: JsonPatchOperation[]): T {
  let root: unknown = structuredClone(document);

  for (const operation of operations) {
    const tokens = pointerTokens(operation.path ?? "");
    if (tokens.some((token) => UNSAFE_KEYS.has(token))) continue;

    if (tokens.length === 0) {
      if (operation.op === "replace" || operation.op === "add") root = operation.value;
      continue;
    }

    // Walk to the container that holds the target.
    let parent: unknown = root;
    for (const token of tokens.slice(0, -1)) {
      parent = isContainer(parent) ? (parent as Record<string, unknown>)[token] : undefined;
    }
    if (!isContainer(parent)) continue;

    const key = tokens[tokens.length - 1];
    if (Array.isArray(parent)) {
      const index = key === "-" ? parent.length : Number(key);
      if (!Number.isInteger(index) || index < 0 || index > parent.length) continue;
      if (operation.op === "add") parent.splice(index, 0, operation.value);
      else if (operation.op === "replace" && index < parent.length) parent[index] = operation.value;
      else if (operation.op === "remove" && index < parent.length) parent.splice(index, 1);
    } else if (operation.op === "add" || operation.op === "replace") {
      parent[key] = operation.value;
    } else if (operation.op === "remove") {
      delete parent[key];
    }
  }

  return root as T;
}

export type DocLanguage = "swift" | "objc";

/** How each language is named in Apple's `interfaceLanguage` fields. */
const INTERFACE_LANGUAGE: Record<DocLanguage, string> = { swift: "swift", objc: "occ" };

/**
 * Get a page in the requested language. Returns the page unchanged when it is
 * already in that language, or patched into it when it carries a variant for
 * it. `available` is false when the page has no rendition in that language, in
 * which case the page is returned as it was.
 */
export function selectLanguageVariant(
  page: AppleDocPage,
  language: DocLanguage
): { page: AppleDocPage; available: boolean } {
  const wanted = INTERFACE_LANGUAGE[language];
  if ((page.identifier?.interfaceLanguage ?? "swift") === wanted) return { page, available: true };

  const variant = page.variantOverrides?.find((override) =>
    override.traits?.some((trait) => trait.interfaceLanguage === wanted)
  );
  if (!variant?.patch) return { page, available: false };

  return { page: applyJsonPatch(page, variant.patch), available: true };
}
