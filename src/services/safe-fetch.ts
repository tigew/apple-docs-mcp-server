/**
 * Shared, SSRF-hardened fetch helpers for the non-`developer.apple.com/documentation`
 * surfaces (Swift.org, WWDC, App Store Review Guidelines, App Store Connect Help,
 * Developer Forums).
 *
 * The original documentation scraper is anchored to a single host on purpose.
 * Every surface added here talks to a *different* origin, so each one must pass
 * an explicit host allowlist through this module — a URL is only fetched if its
 * scheme is HTTPS and its hostname is in the caller's allowlist. That keeps a
 * user-supplied path/slug from being coerced into an arbitrary host.
 */

import axios from "axios";
import { REQUEST_TIMEOUT_MS } from "../constants.js";

// Help-center articles are the largest of these pages (~370KB); WWDC pages
// ~150KB. 8MB leaves generous headroom without inviting a decompression bomb.
const HTML_MAX_BYTES = 8 * 1024 * 1024;
const JSON_MAX_BYTES = 8 * 1024 * 1024;

// Some Apple pages vary their markup for non-browser agents; present a normal
// Safari UA so we get the same server-rendered HTML a browser would.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

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
export async function fetchHtml(url: string, allowedHosts: readonly string[]): Promise<HtmlResponse> {
  assertAllowedUrl(url, allowedHosts);
  const response = await htmlClient.get<string>(url);
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
export async function fetchHtmlFollow(url: string, allowedHosts: readonly string[]): Promise<HtmlResponse> {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    const response = await fetchHtml(current, allowedHosts);
    if (response.status >= 300 && response.status < 400) {
      if (!response.location) throw new Error(`Redirect without a Location header from ${current}.`);
      current = new URL(response.location, current).toString();
      continue;
    }
    return response;
  }
  throw new Error(`Too many redirects fetching ${url}.`);
}

/**
 * Fetch and parse a JSON document from an allowlisted host. Guards against
 * non-object payloads (e.g. an HTML error page served with a 200).
 */
export async function fetchJson<T>(url: string, allowedHosts: readonly string[]): Promise<T> {
  let current = url;
  for (let hop = 0; hop <= MAX_JSON_REDIRECTS; hop++) {
    // Re-validate scheme + host on EVERY hop, including redirect targets — a 3xx
    // Location must not be able to smuggle the fetch to a non-allowlisted host.
    assertAllowedUrl(current, allowedHosts);
    const response = await jsonClient.get<T>(current);

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
