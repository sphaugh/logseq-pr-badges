import { it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, PubSub, TxHashMap } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import { KeyValueStore } from "effect/unstable/persistence";
import { beforeEach, describe, expect } from "vitest";
import { Badges, Event, LiveSlots, NoTokenBadges, runBadges } from "./badges";
import { Cache, layer as cacheLayer } from "./cache";
import { GitHubToken } from "./github";
import { PrRef } from "./ref";
import { Settings } from "./settings";

const ref = (number: number) =>
  new PrRef({ owner: "avride", repo: "av", number });

/** Slots painted through `logseq.provideUI`, in order, and what each last showed. */
let painted: string[] = [];
let shown = new Map<string, string>();
beforeEach(() => {
  painted = [];
  shown = new Map();
  (globalThis as { logseq?: unknown }).logseq = {
    provideUI: ({ slot, template }: { slot: string; template: string }) => {
      painted.push(slot);
      shown.set(slot, template);
    },
  };
});

/** Lets forked fibers run up to their next wait. */
const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 10 }));

describe("runBadges", () => {
  it.effect(
    "redraws every live slot once, then handles new macros until interrupted",
    () =>
      Effect.gen(function* () {
        const liveSlots = yield* TxHashMap.make<string, PrRef>();
        // One PR shown twice: the catch-up must paint each slot once, not once per slot.
        yield* TxHashMap.set(liveSlots, "slot-1a", ref(1));
        yield* TxHashMap.set(liveSlots, "slot-1b", ref(1));
        const events = yield* PubSub.unbounded<Event>();

        const instance = yield* Effect.forkChild(
          runBadges(events).pipe(
            Effect.provide(NoTokenBadges),
            Effect.provideService(LiveSlots, liveSlots),
          ),
        );
        yield* settle;
        expect(painted.sort()).toEqual(["slot-1a", "slot-1b"]);

        // The host records a slot before publishing its macro.
        painted = [];
        yield* TxHashMap.set(liveSlots, "slot-2", ref(2));
        yield* PubSub.publish(events, Event.Slotted({ ref: ref(2) }));
        yield* settle;
        expect(painted).toEqual(["slot-2"]);

        // A settings change interrupts the instance; it must stop handling events.
        painted = [];
        yield* Fiber.interrupt(instance);
        yield* TxHashMap.set(liveSlots, "slot-3", ref(3));
        yield* PubSub.publish(events, Event.Slotted({ ref: ref(3) }));
        yield* settle;
        expect(painted).toEqual([]);
      }),
  );
});

/** A real instance over a stubbed `fetch` and an in-memory cache. `Cache` and
 *  `LiveSlots` are exposed too, so a test can seed them. */
const instance = (fetch: () => Promise<Response>) =>
  Layer.effect(Badges, Badges.make).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.provideMerge(cacheLayer, KeyValueStore.layerMemory),
        Layer.effect(LiveSlots, TxHashMap.make()),
        Layer.succeed(Settings, { token: "tok", ttlMinutes: 15 }),
        Layer.succeed(GitHubToken, "tok"),
        FetchHttpClient.layer.pipe(
          Layer.provide(
            Layer.succeed(
              FetchHttpClient.Fetch,
              fetch as unknown as typeof globalThis.fetch,
            ),
          ),
        ),
      ),
    ),
  );

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Records the slot, as the host does, then hands the macro to the instance. */
const show = (slot: string, pr: PrRef) =>
  Effect.gen(function* () {
    yield* TxHashMap.set(yield* LiveSlots, slot, pr);
    yield* Badges.use((b) => b.handleMacro(pr));
  });

/** Past the batch window, then real ticks for the stubbed fetch to resolve. */
const fetchSettles = TestClock.adjust("1 second").pipe(
  Effect.andThen(
    Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0))),
  ),
  Effect.repeat({ times: 5 }),
);

describe("Badges", () => {
  it.effect("draws a skeleton, then the badge once GitHub answers", () => {
    let calls = 0;
    return Effect.gen(function* () {
      yield* show("slot", ref(1));
      expect(shown.get("slot")).toContain("pr-badge--skeleton");

      yield* fetchSettles;
      expect(calls).toBe(1);
      expect(shown.get("slot")).toContain('data-state="open"');
      expect(shown.get("slot")).toContain("Bringup");
      expect(Option.isSome(yield* Cache.use((c) => c.get(ref(1).key)))).toBe(
        true,
      );
    }).pipe(
      Effect.provide(
        instance(async () => {
          calls += 1;
          return json({
            data: {
              a0: {
                pullRequest: {
                  title: "Bringup",
                  state: "OPEN",
                  isDraft: false,
                },
              },
            },
          });
        }),
      ),
    );
  });

  it.effect("draws a fresh cached badge without fetching", () => {
    let calls = 0;
    return Effect.gen(function* () {
      yield* Cache.use((c) =>
        c.set(ref(1).key, {
          state: "merged",
          title: "Cached",
          fetchedAt: Date.now(),
        }),
      );
      yield* show("slot", ref(1));
      yield* fetchSettles;
      expect(calls).toBe(0);
      expect(shown.get("slot")).toContain("Cached");
    }).pipe(
      Effect.provide(
        instance(async () => {
          calls += 1;
          return json({});
        }),
      ),
    );
  });

  it.effect("remembers a missing PR instead of asking again", () => {
    let calls = 0;
    return Effect.gen(function* () {
      yield* show("slot", ref(1));
      yield* fetchSettles;
      expect(shown.get("slot")).toContain("not found");

      yield* show("other-slot", ref(1));
      yield* fetchSettles;
      expect(calls).toBe(1);
      expect(shown.get("other-slot")).toContain("not found");
    }).pipe(
      Effect.provide(
        instance(async () => {
          calls += 1;
          return json({ data: { a0: null } });
        }),
      ),
    );
  });

  it.effect(
    "links to the PR when GitHub rejects the token and nothing is cached",
    () =>
      Effect.gen(function* () {
        yield* show("slot", ref(1));
        yield* fetchSettles;
        expect(shown.get("slot")).toContain("pr-badge--error");
        expect(shown.get("slot")).toContain(
          'href="https://github.com/avride/av/pull/1"',
        );
        expect(shown.get("slot")).toContain("rejected the token");
      }).pipe(Effect.provide(instance(async () => json({}, 401)))),
  );
});
