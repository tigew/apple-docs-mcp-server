/**
 * The server's only HTTP layer: SSRF-hardened fetch helpers shared by every
 * surface (the documentation JSON API, Swift.org, WWDC, App Store Review
 * Guidelines, App Store Connect Help, Developer Forums, ...).
 *
 * Each surface talks to its own origin, so every call passes an explicit host
 * allowlist — a URL is only fetched if its scheme is HTTPS and its hostname is
 * in the caller's allowlist. That keeps a user-supplied path/slug from being
 * coerced into an arbitrary host. Redirects are never followed automatically:
 * they are either returned to the caller or followed hop by hop with the
 * allowlist re-checked each time. Requests that fail for a transient reason
 * (server error, short rate limit, dropped connection, timeout) are retried,
 * and successful responses are reused from memory for a while.
 */

import axios, { AxiosError } from "axios";
import { REQUEST_TIMEOUT_MS } from "../constants.js";
import { VERSION } from "../version.js";
import { createCache, getOrLoad } from "./cache.js";
import { withRetry } from "./retry.js";

// Help-center articles are the largest of these pages (~370KB); WWDC pages
// ~150KB. 8MB leaves generous headroom without inviting a decompression bomb.
const HTML_MAX_BYTES = 8 * 1024 * 1024;
const JSON_MAX_BYTES = 8 * 1024 * 1024;

/** Identifies this server to Apple's JSON APIs, which don't vary by user agent. */
export const SERVER_USER_AGENT = `apple-docs-mcp-server/${VERSION}`;

// Some Apple pages vary their markup for non-browser agents; present a normal
// Safari UA so we get the same server-rendered HTML a browser would.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

// Successful responses are kept in memory and reused: these pages change
// rarely, several tools read different parts of one large page (every App
// Store Review Guideline lives on a single page), and a model often asks for
// several at once. The budget is in characters of response text.
const responseCache = createCache<unknown>({ maxEntries: 200, maxSize: 24 * 1024 * 1024 });

/** How long a response is reused unless the caller says otherwise. */
export const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000;

export interface CacheOptions {
  /** How long a successful response may be reused. 0 always refetches. Default: 30 minutes. */
  cacheTtlMs?: number;
}

export interface HtmlResponse {
  status: number;
  html: string;
  /** Redirect target when the server answered with a 3xx (we never auto-follow). */
  location?: string;
}

/**
 * Enforce the SSRF posture: HTTPS only, and hostname must be explicitly
 * allowlisted by the caller. Throws otherwise. Exported for unit testing.
 */
export function assertAllowedUrl(url: string, allowedHosts: readonly string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing to fetch non-HTTPS URL: ${url}`);
  }
  if (!allowedHosts.includes(parsed.hostname)) {
    throw new Error(`Refusing to fetch disallowed host "${parsed.hostname}".`);
  }
  return parsed;
}

// maxRedirects: 0 so 3xx responses surface to the caller instead of being
// followed — WWDC uses a 302 to signal "no such session", and the Forums use a
// 302 bot-challenge gate; both must be detectable, not transparently chased
// (following them would also be an SSRF redirect vector).
const htmlClient = axios.create({
  timeout: REQUEST_TIMEOUT_MS,
  maxContentLength: HTML_MAX_BYTES,
  maxBodyLength: HTML_MAX_BYTES,
  maxRedirects: 0,
  responseType: "text",
  headers: {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "User-Agent": BROWSER_UA,
    "Accept-Encoding": "gzip, deflate, br",
  },
  // Resolve (don't throw) on 2xx, 3xx, and 4xx so callers can inspect redirect
  // gates and not-found responses instead of catching a raw axios error.
  validateStatus: (status) => status >= 200 && status < 500,
});

// maxRedirects: 0 for the same reason as htmlClient — axios would otherwise
// follow a 3xx to any Location without re-checking the host allowlist or scheme,
// which would defeat the SSRF posture. fetchJson follows redirects manually,
// re-running assertAllowedUrl on every hop.
const jsonClient = axios.create({
  timeout: REQUEST_TIMEOUT_MS,
  maxContentLength: JSON_MAX_BYTES,
  maxBodyLength: JSON_MAX_BYTES,
  maxRedirects: 0,
  headers: {
    Accept: "application/json",
    "User-Agent": BROWSER_UA,
    "Accept-Encoding": "gzip, deflate, br",
  },
  validateStatus: (status) => status >= 200 && status < 400,
});

const MAX_JSON_REDIRECTS = 3;

/**
 * Fetch a page as text/HTML from an allowlisted host. Returns the status and
 * body without following redirects, so callers can treat a 3xx as a signal
 * (not-found / challenge gate) rather than an error.
 */
export function fetchHtml(
  url: string,
  allowedHosts: readonly string[],
  options: CacheOptions = {}
): Promise<HtmlResponse> {
  assertAllowedUrl(url, allowedHosts);
  return getOrLoad(
    responseCache as ReturnType<typeof createCache<HtmlResponse>>,
    `html:${url}`,
    options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    () => requestHtml(url, allowedHosts),
    // Only a real page is kept: a redirect or an error page may be temporary.
    { sizeOf: (response) => response.html.length, keep: (response) => response.status === 200 }
  );
}

async function requestHtml(url: string, allowedHosts: readonly string[]): Promise<HtmlResponse> {
  const { hostname } = assertAllowedUrl(url, allowedHosts);
  const response = await withRetry(async () => {
    const attempt = await htmlClient.get<string>(url);
    // htmlClient resolves on every 4xx so callers can read redirects and
    // not-found pages; a rate limit is the one that should be retried instead.
    if (attempt.status === 429) {
      throw new AxiosError("Rate limited", AxiosError.ERR_BAD_RESPONSE, attempt.config, attempt.request, attempt);
    }
    return attempt;
  }).catch((error: unknown) => {
    if (error instanceof AxiosError && error.response?.status === 429) {
      throw new Error(`${hostname} is rate limiting requests. Wait a moment and try again.`);
    }
    throw error;
  });
  const location = response.headers?.location;
  return {
    status: response.status,
    html: typeof response.data === "string" ? response.data : String(response.data ?? ""),
    location: typeof location === "string" ? location : undefined,
  };
}

/**
 * Like fetchHtml, but follows redirects manually — re-running assertAllowedUrl
 * on every hop so a 3xx can't escape the host allowlist. For surfaces that
 * legitimately redirect within their own host (e.g. support.apple.com adds a
 * locale segment and maps legacy HT-numbers to numeric ids).
 */
export async function fetchHtmlFollow(
  url: string,
  allowedHosts: readonly string[],
  options: CacheOptions = {}
): Promise<HtmlResponse> {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    const response = await fetchHtml(current, allowedHosts, options);
    if (response.status >= 300 && response.status < 400) {
      if (!response.location) throw new Error(`Redirect without a Location header from ${current}.`);
      current = new URL(response.location, current).toString();
      continue;
    }
    return response;
  }
  throw new Error(`Too many redirects fetching ${url}.`);
}

export interface JsonFetchOptions extends CacheOptions {
  /** Response size cap in bytes (default 8MB). */
  maxBytes?: number;
  /** User-Agent header (default: a browser UA). */
  userAgent?: string;
}

/**
 * Fetch and parse a JSON document from an allowlisted host, following up to
 * MAX_JSON_REDIRECTS redirects. Rejects with an AxiosError on a 4xx/5xx
 * status, and guards against non-object payloads (e.g. an HTML error page
 * served with a 200).
 */
export function fetchJson<T>(
  url: string,
  allowedHosts: readonly string[],
  options: JsonFetchOptions = {}
): Promise<T> {
  assertAllowedUrl(url, allowedHosts);
  return getOrLoad(
    responseCache as ReturnType<typeof createCache<T>>,
    `json:${url}`,
    options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    () => requestJson<T>(url, allowedHosts, options),
    { sizeOf: (data) => JSON.stringify(data).length }
  );
}

async function requestJson<T>(url: string, allowedHosts: readonly string[], options: JsonFetchOptions): Promise<T> {
  const maxBytes = options.maxBytes ?? JSON_MAX_BYTES;
  let current = url;
  for (let hop = 0; hop <= MAX_JSON_REDIRECTS; hop++) {
    // Re-validate scheme + host on EVERY hop, including redirect targets — a 3xx
    // Location must not be able to smuggle the fetch to a non-allowlisted host.
    assertAllowedUrl(current, allowedHosts);
    const hopUrl = current;
    const response = await withRetry(() =>
      jsonClient.get<T>(hopUrl, {
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
        ...(options.userAgent ? { headers: { "User-Agent": options.userAgent } } : {}),
      })
    );

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.location;
      if (typeof location !== "string" || !location) {
        throw new Error(`Redirect without a Location header from ${current}.`);
      }
      current = new URL(location, current).toString(); // resolve relative redirects
      continue;
    }

    const data = response.data;
    if (!data || typeof data !== "object") {
      throw new Error(`Unexpected non-JSON response from ${current}.`);
    }
    return data;
  }
  throw new Error(`Too many redirects fetching ${url}.`);
}

export interface PostOptions extends CacheOptions {
  /** Accept header describing the expected response body. */
  accept: string;
  /** Request timeout in milliseconds (default REQUEST_TIMEOUT_MS). */
  timeoutMs?: number;
  /** User-Agent header (default: a browser UA). */
  userAgent?: string;
}

/**
 * POST a JSON body to an allowlisted host and return the response body as
 * text, unparsed. Rejects with an AxiosError on any non-2xx status; a redirect
 * is never followed, since re-sending a POST body to another URL is not
 * something any of these APIs should ask for.
 */
export function postJsonForText(
  url: string,
  body: unknown,
  allowedHosts: readonly string[],
  options: PostOptions
): Promise<string> {
  assertAllowedUrl(url, allowedHosts);
  return getOrLoad(
    responseCache as ReturnType<typeof createCache<string>>,
    `post:${url}:${JSON.stringify(body)}`,
    options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    () => requestPostForText(url, body, options),
    { sizeOf: (text) => text.length }
  );
}

async function requestPostForText(url: string, body: unknown, options: PostOptions): Promise<string> {
  // Every POST made through here is a read-only query, so repeating it is safe.
  const response = await withRetry(() =>
    axios.post<string>(url, body, {
      timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
      maxContentLength: JSON_MAX_BYTES,
      maxBodyLength: JSON_MAX_BYTES,
      maxRedirects: 0,
      responseType: "text",
      headers: {
        Accept: options.accept,
        "Content-Type": "application/json",
        "User-Agent": options.userAgent ?? BROWSER_UA,
        "Accept-Encoding": "gzip, deflate, br",
      },
      validateStatus: (status) => status >= 200 && status < 300,
    })
  );
  return typeof response.data === "string" ? response.data : String(response.data ?? "");
}
