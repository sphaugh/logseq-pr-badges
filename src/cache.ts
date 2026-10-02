import { Context, Effect, Layer, Option, Schema } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";

export const PrStateSchema = Schema.Literals([
  "open",
  "draft",
  "merged",
  "closed",
]);
export type PrState = typeof PrStateSchema.Type;

export const CacheEntrySchema = Schema.Struct({
  state: PrStateSchema,
  title: Schema.String,
  fetchedAt: Schema.Finite,
});
export type CacheEntry = typeof CacheEntrySchema.Type;

export const PREFIX = "logseq-pr-badges:v1:";
export const DEFAULT_TTL_MS = 15 * 60 * 1000;

export const isTerminal = (s: PrState): boolean =>
  s === "merged" || s === "closed";

export const isFresh = (
  e: CacheEntry,
  now: number,
  ttl: number = DEFAULT_TTL_MS,
): boolean => (isTerminal(e.state) ? true : now - e.fetchedAt < ttl);

export class Cache extends Context.Service<
  Cache,
  {
    readonly get: (key: string) => Effect.Effect<Option.Option<CacheEntry>>;
    readonly set: (key: string, entry: CacheEntry) => Effect.Effect<void>;
  }
>()("logseq-pr-badges/Cache", {
  make: Effect.gen(function* () {
    const kv = yield* KeyValueStore.KeyValueStore;
    const store = KeyValueStore.toSchemaStore(
      KeyValueStore.prefix(kv, PREFIX),
      CacheEntrySchema,
    );
    return {
      // toSchemaStore's get FAILS the Effect on a decode error. A corrupt entry
      // must read as a miss and never propagate.
      get: (key: string) =>
        store.get(key).pipe(Effect.orElseSucceed(Option.none)),
      // Writes are best-effort, matching the shipped behaviour: a failed write
      // just means one more fetch next render. Never propagate.
      set: (key: string, entry: CacheEntry) =>
        Effect.ignore(store.set(key, entry)),
    };
  }),
}) {}

export const layer = Layer.effect(Cache, Cache.make);
