/**
 * Documentation path utilities: normalizing user input into canonical paths, and mapping
 * canonical paths to Apple's JSON endpoints and public web URLs.
 */

import {
  APPLE_DESIGN_PATH_PREFIX,
  APPLE_DEV_ORIGIN,
  APPLE_DOCS_BASE_URL,
  APPLE_DOCS_WEB_BASE,
  APPLE_TUTORIALS_PATH_PREFIX,
} from "../../constants.js";

export function stripDocPrefix(url: string): string {
  return url
    // doc://{bundle-id}/{tree}/... — strip the scheme + bundle authority, keeping
    // the content tree (`documentation/…` or `design/…`) so design paths survive.
    .replace(/^doc:\/\/[^/]*\//i, "")
    .replace(/^https?:\/\/developer\.apple\.com(?=\/|$)/i, "")
    .replace(/^\/+/, "")
    // Only the `documentation/` tree is dropped from the canonical path; the
    // `design/` and `tutorials/` trees are retained (it's how fetch routing
    // recognizes those pages).
    .replace(/^documentation\//i, "");
}

/** True for Apple Design (HIG / SF Symbols) paths, which live under a `design/` tree. */
export function isDesignPath(normalizedPath: string): boolean {
  return normalizedPath === "design" || normalizedPath.startsWith(APPLE_DESIGN_PATH_PREFIX);
}

/** True for tutorial paths, which live under a `tutorials/` tree. */
export function isTutorialPath(normalizedPath: string): boolean {
  return normalizedPath === "tutorials" || normalizedPath.startsWith(APPLE_TUTORIALS_PATH_PREFIX);
}

/**
 * True for paths outside the `documentation/` tree (design guidance and
 * tutorials). Their canonical path carries its tree as a prefix, and they have
 * no per-framework symbol index.
 */
export function hasOwnTree(normalizedPath: string): boolean {
  return isDesignPath(normalizedPath) || isTutorialPath(normalizedPath);
}

/**
 * Map a canonical internal path to its DocC render-JSON endpoint. Framework docs
 * live under `…/data/documentation/{path}.json`; Design guidance (HIG, SF
 * Symbols) and tutorials are the same render API but under
 * `…/data/design/{path}.json` and `…/data/tutorials/{path}.json`, and their
 * canonical paths already carry that prefix — so they map straight through
 * without a `documentation/` segment.
 */
export function docJsonUrl(normalizedPath: string): string {
  if (hasOwnTree(normalizedPath)) {
    return `${APPLE_DOCS_BASE_URL}/${normalizedPath}.json`;
  }
  return `${APPLE_DOCS_BASE_URL}/documentation/${normalizedPath}.json`;
}

export function buildWebUrl(path: string): string {
  // Design and tutorial pages 404 under /documentation/ on the live site —
  // their public URLs are developer.apple.com/design/… and …/tutorials/…
  // (matching the canonical path directly).
  if (hasOwnTree(path)) {
    return `${APPLE_DEV_ORIGIN}/${path}`;
  }
  return `${APPLE_DOCS_WEB_BASE}/${path}`;
}

export function pathFromDocUrl(url: string | undefined): string | null {
  if (!url) return null;

  // Handle doc:// URIs (e.g. doc://com.apple.SwiftUI/documentation/SwiftUI/View)
  if (/^doc:\/\//i.test(url)) {
    const withoutPrefix = stripDocPrefix(url);
    if (!withoutPrefix) return null;
    try {
      return normalizePath(withoutPrefix);
    } catch {
      return null;
    }
  }

  if (/^https?:\/\//i.test(url) && !/^https?:\/\/developer\.apple\.com(\/|$)/i.test(url)) return null;

  const withoutPrefix = stripDocPrefix(url);
  if (!withoutPrefix) return null;

  try {
    return normalizePath(withoutPrefix);
  } catch {
    return null;
  }
}

export function normalizeDocUrl(url: string): string {
  const internalPath = pathFromDocUrl(url);
  if (!internalPath) return url;
  // Design and tutorial paths keep their own tree; only framework docs get a /documentation/ prefix.
  if (hasOwnTree(internalPath)) return `/${internalPath}`;
  return `/documentation/${internalPath}`;
}

export function queryToLikelySlug(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9()_:]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function isInFrameworkScope(path: string, normalizedFramework: string): boolean {
  return path === normalizedFramework || path.startsWith(`${normalizedFramework}/`);
}

/** Lowercase alphanumeric-only key: "CKShare.Metadata" and "CKShareMetadata" both → "cksharemetadata". */
export function alnumKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Symbol name without argument list: "result(value:)" → "result". */
export function baseSymbolName(leaf: string): string {
  return stripLeafDisambiguation(leaf).split("(")[0];
}

export function stripLeafDisambiguation(leaf: string): string {
  let normalized = leaf.trim().toLowerCase();
  if (!normalized) return normalized;

  normalized = normalized.replace(/-(swift|objc|c|cpp)\.[a-z0-9._-]+$/i, "");

  // Only strip opaque suffixes that look like Apple's hex hashes (4-5 lowercase alnum)
  // and only when the prefix contains Swift symbol chars like () or :
  const opaqueSuffixMatch = normalized.match(/^(.*)-([a-z0-9]{4,5})$/);
  if (opaqueSuffixMatch) {
    const prefix = opaqueSuffixMatch[1];
    if (prefix && /[().:+!=<>]/.test(prefix)) {
      normalized = prefix;
    }
  }

  return normalized;
}

export function collectLeafLookupKeys(value: string): Set<string> {
  const raw = value.trim().toLowerCase();
  const keys = new Set<string>();
  if (!raw) return keys;

  keys.add(raw);
  keys.add(stripLeafDisambiguation(raw));
  return keys;
}

export function collectTitleLookupKeys(title: string | undefined): Set<string> {
  const normalized = title?.trim().toLowerCase();
  const keys = new Set<string>();
  if (!normalized) return keys;

  keys.add(normalized);
  keys.add(queryToLikelySlug(normalized));
  return keys;
}

export function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error("Invalid path: must not be empty.");
  }

  // Reject non-Apple HTTP URLs (SEC-011: anchor to hostname boundary to prevent subdomain bypass)
  if (/^https?:\/\//i.test(trimmed) && !/^https?:\/\/developer\.apple\.com(\/|$)/i.test(trimmed)) {
    throw new Error(
      `Invalid path "${path}": only developer.apple.com documentation URLs are supported.`
    );
  }

  // Reject dangerous URI schemes (data:, javascript:, ftp:, etc.)
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed) && !/^doc:\/\//i.test(trimmed)) {
    throw new Error(
      `Invalid path "${path}": unsupported URI scheme.`
    );
  }

  // RED-218: Reject paths containing control characters (codepoint < 0x20 or 0x7F-0x9F)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F-\x9F]/.test(trimmed)) {
    throw new Error(`Invalid path: contains control characters.`);
  }

  // Strip zero-width characters that could be used to bypass validation or confuse matching
  // U+200B (zero-width space), U+200C/D (zero-width non-joiner/joiner), U+FEFF (BOM), U+200E/F (LTR/RTL marks)
  if (/[\u200B\u200C\u200D\uFEFF\u200E\u200F\u2060\u2061\u2062\u2063\u2064]/.test(trimmed)) {
    throw new Error(`Invalid path: contains invisible Unicode characters.`);
  }

  // RED-202: Decode URL-encoded sequences before checking for traversal
  // Decode iteratively to catch double-encoding (BUG-15 fix)
  let decoded = trimmed;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      if (i === 0) {
        throw new Error(`Invalid path "${path}": contains malformed percent-encoding.`);
      }
      break;
    }
  }

  // Re-check for control characters after decoding (encoded control chars)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F-\x9F]/.test(decoded)) {
    throw new Error(`Invalid path: contains control characters (after decoding).`);
  }

  // Accept full Apple docs URLs, doc:// URIs, and /documentation/... inputs.
  const withoutPrefix = stripDocPrefix(decoded).replace(/[?#].*$/, "");

  // Strip leading slash, trailing slash, duplicate slashes, and .json suffix.
  const normalized = withoutPrefix
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\.json$/i, "")
    .toLowerCase();

  // RED-007: Reject path traversal attempts (checked after decoding)
  if (normalized.includes("..")) {
    throw new Error(`Invalid path "${path}": path traversal ("..") is not allowed.`);
  }

  // Reject paths with URL-unsafe characters that could alter request semantics
  if (/[@;,]/.test(normalized)) {
    throw new Error(`Invalid path "${path}": contains characters that are not allowed in documentation paths.`);
  }

  if (!normalized) {
    throw new Error(`Invalid path "${path}": no documentation path remained after normalization.`);
  }
  return normalized;
}
