/**
 * Retrying requests that failed for a reason likely to pass: a server error, a
 * short rate limit, a dropped connection, or a timeout.
 */

import { AxiosError } from "axios";

// Attempts in total, including the first.
const MAX_ATTEMPTS = 3;
// An attempt that ran out the request timeout has already waited that long,
// so it gets one more try rather than two.
const MAX_ATTEMPTS_AFTER_TIMEOUT = 2;
// Wait before the first retry; each later retry waits three times longer.
const BASE_DELAY_MS = 300;
// A rate limit that asks for longer than this is reported, not waited out: a
// tool call should not sit silent for minutes.
const MAX_RETRY_AFTER_MS = 5000;

// axios reports its own request timeout as ECONNABORTED.
const REQUEST_TIMEOUT_CODES = new Set(["ECONNABORTED"]);
// Connection-level failures worth another try. ETIMEDOUT here is the socket
// failing to connect (seen intermittently against developer.apple.com), which
// fails quickly. A failed DNS lookup (ENOTFOUND) is deliberately absent: it
// means "offline", and retrying only delays saying so.
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ERR_NETWORK"]);

export interface RetryOptions {
  /** Waits between attempts. Injectable so tests need not really sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** A number in [0, 1) used to spread retries out. Injectable for deterministic tests. */
  random?: () => number;
}

/** How long a 429 response asks the client to wait, if it says so in seconds. */
function retryAfterMs(error: AxiosError): number | undefined {
  const header = error.response?.headers?.["retry-after"];
  const seconds = Number(Array.isArray(header) ? header[0] : header);
  return header !== undefined && header !== null && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/**
 * Decide whether to try again after `error` on the given (1-based) attempt.
 * Returns the wait in milliseconds, or null to give up.
 */
function delayBeforeRetry(error: unknown, attempt: number, random: () => number): number | null {
  if (!(error instanceof AxiosError)) return null;

  const backoff = Math.round(BASE_DELAY_MS * 3 ** (attempt - 1) * (0.5 + 0.5 * random()));
  const status = error.response?.status;

  if (status !== undefined) {
    if (attempt >= MAX_ATTEMPTS) return null;
    if (status === 429) {
      const asked = retryAfterMs(error);
      if (asked === undefined) return backoff;
      return asked <= MAX_RETRY_AFTER_MS ? asked : null;
    }
    return status >= 500 ? backoff : null;
  }

  const code = error.code ?? "";
  if (REQUEST_TIMEOUT_CODES.has(code)) return attempt < MAX_ATTEMPTS_AFTER_TIMEOUT ? backoff : null;
  if (TRANSIENT_NETWORK_CODES.has(code)) return attempt < MAX_ATTEMPTS ? backoff : null;
  return null;
}

/**
 * Run `operation`, retrying when it fails with a transient HTTP or network
 * error. Rethrows the last error once it stops being worth retrying.
 */
export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const delay = delayBeforeRetry(error, attempt, random);
      if (delay === null) throw error;
      await sleep(delay);
    }
  }
}
