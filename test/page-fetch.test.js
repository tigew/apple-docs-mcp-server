import test from "node:test";
import assert from "node:assert/strict";
import { AxiosError } from "axios";

import { createDocPageFetcher } from "../dist/services/docs/page.js";

const httpError = (status) =>
  new AxiosError(`Request failed with status code ${status}`, "ERR_BAD_RESPONSE", undefined, undefined, { status });

const pageAt = (path) => ({
  identifier: { url: `doc://com.apple.test/documentation/${path}`, interfaceLanguage: "swift" },
  metadata: { title: path.split("/").pop() },
});

// Fake documentation sources. `pages` maps a path to a page, or to an Error to
// throw; unlisted paths are 404s. Every call is counted.
function fakeSources({ pages = {}, resolveOn404 = async () => null, resolveSuggestions = async () => ({ suggestions: [], crossFramework: false }) } = {}) {
  const calls = { fetchPage: [], resolveOn404: [], resolveSuggestions: [] };
  return {
    calls,
    sources: {
      fetchPage: async (path) => {
        calls.fetchPage.push(path);
        const entry = Object.prototype.hasOwnProperty.call(pages, path) ? pages[path] : httpError(404);
        if (typeof entry === "function") return entry();
        if (entry instanceof Error) throw entry;
        return entry;
      },
      resolveOn404: async (path) => {
        calls.resolveOn404.push(path);
        return resolveOn404(path);
      },
      resolveSuggestions: async (path) => {
        calls.resolveSuggestions.push(path);
        return resolveSuggestions(path);
      },
    },
  };
}

function fakeClock(start = 1_000_000) {
  let time = start;
  return { now: () => time, advance: (ms) => (time += ms) };
}

const MINUTE = 60 * 1000;

test("a page is downloaded once and then served from memory", async () => {
  const { sources, calls } = fakeSources({ pages: { "swiftui/view": pageAt("swiftui/view") } });
  const fetchPage = createDocPageFetcher(sources);

  const first = await fetchPage("swiftui/view");
  const second = await fetchPage("SwiftUI/View/"); // same page, differently spelled

  assert.equal(first.page.metadata.title, "view");
  assert.equal(first.redirectedFrom, undefined);
  assert.equal(second.page, first.page);
  assert.deepEqual(calls.fetchPage, ["swiftui/view"]);
});

test("a recovered path is remembered under both the path asked for and the real one", async () => {
  const { sources, calls } = fakeSources({
    pages: { "relevancekit/relevantcontext": pageAt("relevancekit/relevantcontext") },
    resolveSuggestions: async () => ({ autoResolvePath: "relevancekit/relevantcontext", suggestions: [], crossFramework: true }),
  });
  const fetchPage = createDocPageFetcher(sources);

  const recovered = await fetchPage("widgetkit/relevantcontext");
  assert.equal(recovered.redirectedFrom, "widgetkit/relevantcontext");
  assert.equal(recovered.page.metadata.title, "relevantcontext");

  // Asking again repeats neither the failed download nor the recovery search,
  // and still says the page is not the one asked for.
  const again = await fetchPage("widgetkit/relevantcontext");
  assert.equal(again.redirectedFrom, "widgetkit/relevantcontext");
  // The real path was learned along the way.
  const direct = await fetchPage("relevancekit/relevantcontext");
  assert.equal(direct.redirectedFrom, undefined);

  assert.deepEqual(calls.fetchPage, ["widgetkit/relevantcontext", "relevancekit/relevantcontext"]);
  assert.equal(calls.resolveSuggestions.length, 1);
});

test("a path that does not exist is answered from memory the second time", async () => {
  const { sources, calls } = fakeSources({
    resolveSuggestions: async () => ({
      suggestions: [{ path: "swiftui/view", title: "View" }],
      crossFramework: false,
    }),
  });
  const fetchPage = createDocPageFetcher(sources);

  await assert.rejects(fetchPage("swiftui/veiw"), /Did you mean:\n  - `swiftui\/view`/);
  await assert.rejects(fetchPage("swiftui/veiw"), /Did you mean:\n  - `swiftui\/view`/);

  // The second answer cost no downloads and no searches.
  assert.deepEqual(calls.fetchPage, ["swiftui/veiw"]);
  assert.equal(calls.resolveOn404.length, 1);
  assert.equal(calls.resolveSuggestions.length, 1);
});

test("a not-found answer names the path as the caller spelled it each time", async () => {
  const { sources } = fakeSources();
  const fetchPage = createDocPageFetcher(sources);

  await assert.rejects(fetchPage("nope/Missing"), /not found for path "nope\/Missing"/);
  await assert.rejects(fetchPage("NOPE/missing"), /not found for path "NOPE\/missing"/);
});

test("a not-found answer is forgotten after ten minutes, in case the page has appeared", async () => {
  const clock = fakeClock();
  const { sources, calls } = fakeSources();
  const fetchPage = createDocPageFetcher(sources, { now: clock.now });

  await assert.rejects(fetchPage("nope/missing"), /not found/);
  clock.advance(9 * MINUTE);
  await assert.rejects(fetchPage("nope/missing"), /not found/);
  assert.equal(calls.fetchPage.length, 1);

  clock.advance(2 * MINUTE);
  await assert.rejects(fetchPage("nope/missing"), /not found/);
  assert.equal(calls.fetchPage.length, 2);
});

test("a not-found answer is not remembered when the recovery search itself could not finish", async () => {
  const { sources, calls } = fakeSources({
    resolveSuggestions: async () => ({ suggestions: [], crossFramework: false, incomplete: true }),
  });
  const fetchPage = createDocPageFetcher(sources);

  await assert.rejects(fetchPage("swiftui/veiw"), /not found/);
  await assert.rejects(fetchPage("swiftui/veiw"), /not found/);

  // Tried again in full: the first answer might have been wrong.
  assert.equal(calls.resolveSuggestions.length, 2);
});

test("a temporary failure is not remembered", async () => {
  let attempts = 0;
  const { sources } = fakeSources({
    pages: {
      "swiftui/view": () => {
        if (++attempts === 1) throw httpError(503);
        return pageAt("swiftui/view");
      },
    },
  });
  const fetchPage = createDocPageFetcher(sources);

  await assert.rejects(fetchPage("swiftui/view"), /server returned an error/);
  assert.equal((await fetchPage("swiftui/view")).page.metadata.title, "view");
});

test("a page is downloaded again once it is thirty minutes old", async () => {
  const clock = fakeClock();
  const { sources, calls } = fakeSources({ pages: { "swiftui/view": pageAt("swiftui/view") } });
  const fetchPage = createDocPageFetcher(sources, { now: clock.now });

  await fetchPage("swiftui/view");
  clock.advance(29 * MINUTE);
  await fetchPage("swiftui/view");
  assert.equal(calls.fetchPage.length, 1);

  clock.advance(2 * MINUTE);
  await fetchPage("swiftui/view");
  assert.equal(calls.fetchPage.length, 2);
});
