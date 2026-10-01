import { it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { KeyValueStore } from "effect/unstable/persistence";
import { describe, expect } from "vitest";
import {
  Cache,
  type CacheEntry,
  DEFAULT_TTL_MS,
  isFresh,
  isTerminal,
  layer,
  PREFIX,
} from "./cache";

const testLayer = Layer.provideMerge(layer, KeyValueStore.layerMemory);

const failingStore = KeyValueStore.makeStringOnly({
  get: () =>
    Effect.fail(
      new KeyValueStore.KeyValueStoreError({
        message: "read failed",
        method: "get",
      }),
    ),
  set: () =>
    Effect.fail(
      new KeyValueStore.KeyValueStoreError({
        message: "write failed",
        method: "set",
      }),
    ),
  remove: () => Effect.void,
  clear: Effect.void,
  size: Effect.succeed(0),
});

const failingLayer = Layer.provideMerge(
  layer,
  Layer.succeed(KeyValueStore.KeyValueStore, failingStore),
);

const entry = (o: Partial<CacheEntry> = {}): CacheEntry => ({
  state: "open",
  title: "A title",
  url: "https://x.test/1",
  fetchedAt: 1000,
  ...o,
});

describe("isTerminal", () => {
  it("treats merged and closed as terminal", () => {
    expect(isTerminal("merged")).toBe(true);
    expect(isTerminal("closed")).toBe(true);
  });
  it("treats open and draft as non-terminal", () => {
    expect(isTerminal("open")).toBe(false);
    expect(isTerminal("draft")).toBe(false);
  });
});

describe("Cache", () => {
  it.effect("round-trips an entry", () =>
    Effect.gen(function* () {
      const cache = yield* Cache;
      yield* cache.set("avride/av#1", entry());
      expect(Option.getOrNull(yield* cache.get("avride/av#1"))).toEqual(
        entry(),
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("returns none for a miss", () =>
    Effect.gen(function* () {
      const cache = yield* Cache;
      expect(Option.isNone(yield* cache.get("nope/nope#1"))).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reads a corrupt entry as a miss instead of failing", () =>
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      yield* kv.set(`${PREFIX}avride/av#1`, "{not json");
      const cache = yield* Cache;
      expect(Option.isNone(yield* cache.get("avride/av#1"))).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reads an entry with an unknown state as a miss", () =>
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      yield* kv.set(
        `${PREFIX}avride/av#1`,
        JSON.stringify({ ...entry(), state: "exploded" }),
      );
      const cache = yield* Cache;
      expect(Option.isNone(yield* cache.get("avride/av#1"))).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("namespaces keys with the schema version", () =>
    Effect.gen(function* () {
      const cache = yield* Cache;
      yield* cache.set("avride/av#1", entry());
      const kv = yield* KeyValueStore.KeyValueStore;
      // Raw KeyValueStore.get returns `string | undefined` — unlike the schema
      // store's get, which returns an Option.
      const raw = yield* kv.get("logseq-pr-badges:v1:avride/av#1");
      expect(raw).toBeTypeOf("string");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reads an entry with missing fields as a miss", () =>
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      yield* kv.set(`${PREFIX}avride/av#1`, JSON.stringify({ state: "open" }));
      const cache = yield* Cache;
      expect(Option.isNone(yield* cache.get("avride/av#1"))).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "reads as a miss when the underlying store fails, not only when decoding fails",
    () =>
      Effect.gen(function* () {
        const cache = yield* Cache;
        expect(Option.isNone(yield* cache.get("avride/av#1"))).toBe(true);
      }).pipe(Effect.provide(failingLayer)),
  );

  it.effect("swallows a failing write, because the cache is best-effort", () =>
    // Must not fail. A failed write just means one more fetch next render.
    Cache.use((cache) => cache.set("avride/av#1", entry())).pipe(
      Effect.provide(failingLayer),
    ),
  );
});

describe("isFresh", () => {
  it.effect("treats a recent non-terminal entry as fresh, then stale", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(DEFAULT_TTL_MS - 1);
      const t1 = yield* Effect.clockWith((c) => c.currentTimeMillis);
      expect(isFresh(entry({ fetchedAt: 0 }), t1)).toBe(true);
      yield* TestClock.adjust(2);
      const t2 = yield* Effect.clockWith((c) => c.currentTimeMillis);
      expect(isFresh(entry({ fetchedAt: 0 }), t2)).toBe(false);
    }),
  );

  it.effect("pins terminal states regardless of the clock", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("365 days");
      const now = yield* Effect.clockWith((c) => c.currentTimeMillis);
      expect(isFresh(entry({ state: "merged", fetchedAt: 0 }), now)).toBe(true);
      expect(isFresh(entry({ state: "closed", fetchedAt: 0 }), now)).toBe(true);
    }),
  );

  it("honours a custom ttl", () => {
    expect(isFresh(entry({ fetchedAt: 0 }), 500, 1000)).toBe(true);
    expect(isFresh(entry({ fetchedAt: 0 }), 1500, 1000)).toBe(false);
  });
});
