import { it } from "@effect/vitest";
import { Effect, Fiber, PubSub, TxHashMap } from "effect";
import { beforeEach, describe, expect } from "vitest";
import { Event, LiveSlots, NoTokenBadges, runBadges } from "./badges";
import { PrRef } from "./ref";

const ref = (number: number) =>
  new PrRef({ owner: "avride", repo: "av", number });

/** Slots painted through `logseq.provideUI`, in order. */
let painted: string[] = [];
beforeEach(() => {
  painted = [];
  (globalThis as { logseq?: unknown }).logseq = {
    provideUI: ({ slot }: { slot: string }) => painted.push(slot),
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
