import test from "node:test";
import assert from "node:assert/strict";

import { createCache, getOrLoad } from "../dist/services/cache.js";

// A clock the test moves by hand.
function fakeClock(start = 1_000_000) {
  let time = start;
  return { now: () => time, advance: (ms) => (time += ms) };
}

test("a cached value is returned until its time to live runs out", () => {
  const clock = fakeClock();
  const cache = createCache({ maxEntries: 10, now: clock.now });

  cache.set("page", "content", 1000);
  clock.advance(999);
  assert.equal(cache.get("page"), "content");
  clock.advance(2);
  assert.equal(cache.get("page"), undefined);
});

test("each entry keeps its own time to live", () => {
  const clock = fakeClock();
  const cache = createCache({ maxEntries: 10, now: clock.now });

  cache.set("listing", "fresh for a minute", 60_000);
  cache.set("article", "fresh for an hour", 3_600_000);
  clock.advance(61_000);

  assert.equal(cache.get("listing"), undefined);
  assert.equal(cache.get("article"), "fresh for an hour");
});

test("the least recently used entry is dropped when the cache is full", () => {
  const cache = createCache({ maxEntries: 2 });

  cache.set("a", 1, 60_000);
  cache.set("b", 2, 60_000);
  assert.equal(cache.get("a"), 1); // "a" is now the more recently used
  cache.set("c", 3, 60_000);

  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
});

test("entries are dropped, oldest first, to stay within the size budget", () => {
  const cache = createCache({ maxEntries: 100, maxSize: 100 });

  cache.set("a", "A", 60_000, 40);
  cache.set("b", "B", 60_000, 40);
  cache.set("c", "C", 60_000, 40); // 120 > 100: "a" has to go

  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), "B");
  assert.equal(cache.get("c"), "C");
});

test("replacing an entry replaces its size rather than adding to it", () => {
  const cache = createCache({ maxEntries: 100, maxSize: 100 });

  cache.set("a", "first", 60_000, 60);
  cache.set("a", "second", 60_000, 30);
  cache.set("b", "B", 60_000, 60); // 30 + 60 fits; it would not if "a" still counted as 60 + 30

  assert.equal(cache.get("a"), "second");
  assert.equal(cache.get("b"), "B");
});

test("a value larger than the whole size budget is not cached, and evicts nothing", () => {
  const cache = createCache({ maxEntries: 100, maxSize: 100 });

  cache.set("small", "S", 60_000, 10);
  cache.set("huge", "H", 60_000, 500);

  assert.equal(cache.get("huge"), undefined);
  assert.equal(cache.get("small"), "S");
});

test("getOrLoad loads a value once and serves it from the cache afterwards", async () => {
  const cache = createCache({ maxEntries: 10 });
  let loads = 0;
  const load = async () => `loaded ${++loads}`;

  assert.equal(await getOrLoad(cache, "key", 60_000, load), "loaded 1");
  assert.equal(await getOrLoad(cache, "key", 60_000, load), "loaded 1");
  assert.equal(loads, 1);
});

test("getOrLoad shares one load between callers that ask at the same time", async () => {
  const cache = createCache({ maxEntries: 10 });
  // Each load stays pending until released, so both callers are waiting at once.
  const pending = [];
  const load = () => new Promise((resolve) => pending.push(resolve));

  const first = getOrLoad(cache, "key", 60_000, load);
  const second = getOrLoad(cache, "key", 60_000, load);
  const started = pending.length;
  pending.forEach((release, index) => release(`value ${index + 1}`));

  assert.deepEqual(await Promise.all([first, second]), ["value 1", "value 1"]);
  assert.equal(started, 1);
});

test("getOrLoad does not cache a failure, so the next call tries again", async () => {
  const cache = createCache({ maxEntries: 10 });
  let loads = 0;
  const load = async () => {
    if (++loads === 1) throw new Error("temporary");
    return "recovered";
  };

  await assert.rejects(getOrLoad(cache, "key", 60_000, load), /temporary/);
  assert.equal(await getOrLoad(cache, "key", 60_000, load), "recovered");
});

test("getOrLoad with a zero time to live always loads", async () => {
  const cache = createCache({ maxEntries: 10 });
  let loads = 0;
  const load = async () => ++loads;

  assert.equal(await getOrLoad(cache, "key", 0, load), 1);
  assert.equal(await getOrLoad(cache, "key", 0, load), 2);
});

test("getOrLoad leaves out values the caller says not to keep", async () => {
  const cache = createCache({ maxEntries: 10 });
  let loads = 0;
  const load = async () => ({ status: ++loads === 1 ? 302 : 200 });
  const options = { keep: (response) => response.status === 200 };

  assert.deepEqual(await getOrLoad(cache, "key", 60_000, load, options), { status: 302 }); // not kept
  assert.deepEqual(await getOrLoad(cache, "key", 60_000, load, options), { status: 200 }); // kept
  assert.deepEqual(await getOrLoad(cache, "key", 60_000, load, options), { status: 200 });
  assert.equal(loads, 2);
});
