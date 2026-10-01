import { it } from "@effect/vitest";
import { Effect, Fiber, PubSub, TxHashMap } from "effect";
import { beforeEach, describe, expect } from "vitest";
import { Event, LiveSlots, NoTokenBadges, runBadges } from "./badges";
import { PrRef } from "./ref";

const REF = new PrRef({ owner: "avride", repo: "av", number: 36812 });

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
    "redraws every live slot, then handles new macros until interrupted",
    () =>
      Effect.gen(function* () {
        const liveSlots = yield* TxHashMap.make<string, PrRef>();
        yield* TxHashMap.set(liveSlots, "slot-1", REF);
        const events = yield* PubSub.unbounded<Event>();

        const instance = yield* Effect.forkChild(
          runBadges(events).pipe(
            Effect.provide(NoTokenBadges),
            Effect.provideService(LiveSlots, liveSlots),
          ),
        );
        yield* settle;
        expect(painted).toEqual(["slot-1"]);

        yield* PubSub.publish(
          events,
          Event.Slotted({ slot: "slot-2", ref: REF }),
        );
        yield* settle;
        expect(painted).toEqual(["slot-1", "slot-2"]);

        // A settings change interrupts the instance; it must stop handling events.
        yield* Fiber.interrupt(instance);
        yield* PubSub.publish(
          events,
          Event.Slotted({ slot: "slot-3", ref: REF }),
        );
        yield* settle;
        expect(painted).toEqual(["slot-1", "slot-2"]);
      }),
  );
});
