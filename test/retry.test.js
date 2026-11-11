import test from "node:test";
import assert from "node:assert/strict";
import { AxiosError } from "axios";

import { withRetry } from "../dist/services/retry.js";

const httpError = (status, headers = {}) =>
  new AxiosError(`Request failed with status code ${status}`, "ERR_BAD_RESPONSE", undefined, undefined, { status, headers });
const networkError = (code) => new AxiosError(`network: ${code}`, code);

// Run `outcomes` in order: an Error is thrown, anything else is returned.
// Records the waits requested between attempts instead of sleeping.
function scripted(outcomes) {
  const waits = [];
  let attempts = 0;
  const operation = async () => {
    const outcome = outcomes[Math.min(attempts, outcomes.length - 1)];
    attempts++;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  const options = { sleep: async (ms) => void waits.push(ms), random: () => 0 };
  return { operation, options, waits, attempts: () => attempts };
}

test("withRetry returns a first-time success without waiting", async () => {
  const run = scripted(["ok"]);

  assert.equal(await withRetry(run.operation, run.options), "ok");
  assert.equal(run.attempts(), 1);
  assert.deepEqual(run.waits, []);
});

test("withRetry retries a server error and returns the eventual success", async () => {
  const run = scripted([httpError(503), httpError(502), "ok"]);

  assert.equal(await withRetry(run.operation, run.options), "ok");
  assert.equal(run.attempts(), 3);
  // Backoff grows between attempts (150ms then 450ms at the low end of the jitter range).
  assert.deepEqual(run.waits, [150, 450]);
});

test("withRetry gives up after three attempts and rethrows the last error", async () => {
  const last = httpError(503);
  const run = scripted([httpError(500), httpError(502), last]);

  await assert.rejects(withRetry(run.operation, run.options), (error) => error === last);
  assert.equal(run.attempts(), 3);
});

test("withRetry does not retry errors that will not go away", async () => {
  for (const error of [httpError(404), httpError(400), httpError(403), networkError("ENOTFOUND"), new Error("parse failure")]) {
    const run = scripted([error, "ok"]);

    await assert.rejects(withRetry(run.operation, run.options), (thrown) => thrown === error);
    assert.equal(run.attempts(), 1, String(error.message));
  }
});

test("withRetry retries a dropped connection", async () => {
  const run = scripted([networkError("ECONNRESET"), "ok"]);

  assert.equal(await withRetry(run.operation, run.options), "ok");
  assert.equal(run.attempts(), 2);
});

test("withRetry gives a failed connection attempt the full three tries", async () => {
  // ETIMEDOUT comes from the socket failing to connect, which fails fast —
  // unlike ECONNABORTED, which is the request's own timeout running out.
  const run = scripted([networkError("ETIMEDOUT"), networkError("ETIMEDOUT"), "ok"]);

  assert.equal(await withRetry(run.operation, run.options), "ok");
  assert.equal(run.attempts(), 3);
});

test("withRetry retries a timeout only once, since each attempt already waited the full timeout", async () => {
  const run = scripted([networkError("ECONNABORTED"), networkError("ECONNABORTED"), "ok"]);

  await assert.rejects(withRetry(run.operation, run.options), (error) => error.code === "ECONNABORTED");
  assert.equal(run.attempts(), 2);
});

test("withRetry waits as long as a rate-limited response asks, when that is short", async () => {
  const run = scripted([httpError(429, { "retry-after": "2" }), "ok"]);

  assert.equal(await withRetry(run.operation, run.options), "ok");
  assert.deepEqual(run.waits, [2000]);
});

test("withRetry fails at once when a rate limit asks for a long wait", async () => {
  const limited = httpError(429, { "retry-after": "120" });
  const run = scripted([limited, "ok"]);

  await assert.rejects(withRetry(run.operation, run.options), (error) => error === limited);
  assert.equal(run.attempts(), 1);
  assert.deepEqual(run.waits, []);
});
