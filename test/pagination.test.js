import test from "node:test";
import assert from "node:assert/strict";

import { paginateJson, paginateJsonList, paginateText } from "../dist/tools/truncation.js";

const LIMIT = 25000;

// A long markdown-like document: 2,000 numbered lines of ~40 characters (about 80KB).
const longDocument = Array.from({ length: 2000 }, (_, i) => `Line ${i}: the quick brown fox jumps over.`).join("\n");

const CONTINUING = /^\*\(Continuing from character (\d+) of (\d+)\.\)\*\n\n/;
const TRUNCATED = /\n\n\*\(Truncated: showing characters (\d+)–(\d+) of (\d+)\. Call again with offset=(\d+) to continue\.\)\*$/;

// Walk every page of a text response, returning the pages and their bodies (notes stripped).
function readAllPages(full) {
  const pages = [];
  const bodies = [];
  let offset = 0;
  for (let guard = 0; guard < 100; guard++) {
    const page = paginateText(full, offset);
    pages.push(page);
    bodies.push(page.replace(CONTINUING, "").replace(TRUNCATED, ""));
    const more = page.match(TRUNCATED);
    if (!more) return { pages, bodies };
    offset = Number(more[4]);
  }
  throw new Error("pagination did not terminate");
}

test("paginateText returns a short response unchanged", () => {
  assert.equal(paginateText("# Title\n\nShort body.", 0), "# Title\n\nShort body.");
});

test("paginateText pages cover a long response exactly, each within the size limit", () => {
  const { pages, bodies } = readAllPages(longDocument);

  assert.ok(pages.length >= 4, `expected several pages, got ${pages.length}`);
  for (const page of pages) assert.ok(page.length <= LIMIT, `page of ${page.length} chars exceeds ${LIMIT}`);
  assert.equal(bodies.join(""), longDocument);
});

test("paginateText tells the caller which offset continues the response", () => {
  const first = paginateText(longDocument, 0);
  const note = first.match(TRUNCATED);

  assert.ok(note, "first page should end with a truncation note");
  assert.equal(note[1], "0");
  assert.equal(note[3], String(longDocument.length));
  assert.equal(note[2], note[4], "the next offset is where this page stopped");

  const second = paginateText(longDocument, Number(note[4]));
  assert.match(second, CONTINUING);
  assert.equal(second.match(CONTINUING)[1], note[4]);
});

test("paginateText ends a page on a line break rather than mid-line", () => {
  const { bodies } = readAllPages(longDocument);

  assert.ok(bodies.length >= 2, "the document should span several pages");
  for (const body of bodies.slice(0, -1)) {
    assert.match(body, /Line \d+: the quick brown fox jumps over\.\n$/);
  }
});

test("paginateText breaks a single very long line between words", () => {
  // WWDC transcripts are one line of sentences with no line breaks.
  const transcript = Array.from({ length: 9000 }, (_, i) => `word${i}`).join(" ");
  const { pages, bodies } = readAllPages(transcript);

  assert.ok(pages.length >= 2);
  assert.equal(bodies.join(""), transcript);
  for (const body of bodies.slice(0, -1)) assert.match(body, / $/, "a page should stop at a space");
});

test("paginateText keeps code fences balanced on both sides of a page break", () => {
  const code = Array.from({ length: 1500 }, (_, i) => `let value${i} = compute(${i})`).join("\n");
  const full = `Intro.\n\n\`\`\`swift\n${code}\n\`\`\`\n\nOutro.`;

  const first = paginateText(full, 0);
  const next = Number(first.match(TRUNCATED)[4]);
  const second = paginateText(full, next);

  // The break falls inside the listing: page one closes the fence it opened,
  // and page two reopens it, with its language, before continuing the code.
  assert.match(first, /\n```\n\n\*\(Truncated:/);
  assert.match(second.replace(CONTINUING, ""), /^```swift\nlet value\d+ = compute\(\d+\)\n/);
});

test("paginateText reports an offset beyond the end instead of returning nothing", () => {
  assert.match(paginateText(longDocument, longDocument.length + 10), /offset \d+ is past the end/);
  assert.match(paginateText("short", 99), /offset 99 is past the end/);
});

test("paginateJson returns a small value as plain JSON", () => {
  assert.equal(paginateJson({ title: "View", items: [1, 2] }, 0), JSON.stringify({ title: "View", items: [1, 2] }, null, 2));
});

test("paginateJson splits a large value into chunks that reassemble into the original", () => {
  const value = { title: "Big", overview: longDocument, items: Array.from({ length: 300 }, (_, i) => ({ id: i, name: `item "${i}"` })) };

  let offset = 0;
  let rebuilt = "";
  let responses = 0;
  for (let guard = 0; guard < 100; guard++) {
    const response = paginateJson(value, offset);
    responses++;
    assert.ok(response.length <= LIMIT, `response of ${response.length} chars exceeds ${LIMIT}`);
    const envelope = JSON.parse(response); // every response is valid JSON on its own
    assert.equal(envelope.truncated, true);
    assert.equal(envelope.offset, offset);
    assert.equal(envelope.total_length, JSON.stringify(value, null, 2).length);
    rebuilt += envelope.chunk;
    if (envelope.next_offset === null) break;
    offset = envelope.next_offset;
  }

  assert.ok(responses >= 4);
  assert.deepEqual(JSON.parse(rebuilt), value);
});

test("paginateJsonList returns a small list whole, without paging fields", () => {
  const text = paginateJsonList({ count: 2 }, "posts", [{ id: 1 }, { id: 2 }], 0);

  assert.deepEqual(JSON.parse(text), { count: 2, posts: [{ id: 1 }, { id: 2 }] });
});

test("paginateJsonList pages through whole items and reports the next offset", () => {
  const items = Array.from({ length: 900 }, (_, i) => ({ id: i, title: `Article number ${i}`, path: `help/app-store-connect/section/article-${i}` }));

  let offset = 0;
  const seen = [];
  let responses = 0;
  for (let guard = 0; guard < 100; guard++) {
    const text = paginateJsonList({ count: items.length }, "articles", items, offset);
    responses++;
    assert.ok(text.length <= LIMIT, `response of ${text.length} chars exceeds ${LIMIT}`);
    const page = JSON.parse(text);
    assert.equal(page.count, items.length);
    assert.equal(page.offset, offset);
    assert.ok(page.articles.length > 0, "every page must make progress");
    seen.push(...page.articles);
    if (page.next_offset === null) break;
    assert.equal(page.next_offset, offset + page.articles.length);
    offset = page.next_offset;
  }

  assert.ok(responses >= 3);
  assert.deepEqual(seen, items);
});

test("paginateJsonList reports an offset beyond the end as an empty final page", () => {
  const page = JSON.parse(paginateJsonList({ count: 2 }, "posts", [{ id: 1 }, { id: 2 }], 5));

  assert.deepEqual(page.posts, []);
  assert.equal(page.next_offset, null);
});
