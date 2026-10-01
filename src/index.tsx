import "@logseq/libs";
import {
  Effect,
  Fiber,
  Layer,
  Option,
  PubSub,
  Queue,
  Runtime,
  Stream,
  TxHashMap,
} from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { KeyValueStore } from "effect/unstable/persistence";
import { ErrorBadge } from "./badge";
import {
  badgesFor,
  draw,
  Event,
  LiveSlots,
  logDefects,
  runBadges,
} from "./badges";
import { layer as cacheLayer } from "./cache";
import { parseRef } from "./ref";
import { decodeSettings } from "./settings";
import styles from "./styles.css?raw";

const MACRO = ":pr";

// The Layers are assembled once, here, and built when the program starts. The thunk
// passed to `layerStorage` is what makes a module-level construction safe: it
// defers touching `localStorage` until an Effect actually runs.
//
// TracerPropagationEnabled defaults to true, which makes the client attach
// `traceparent`/`b3` headers to every outgoing request. This plugin's only
// request is a cross-origin POST (to api.github.com) that already forces a
// CORS preflight because of the Authorization header; GitHub's preflight
// response does not allow those extra tracing headers, so leaving this on
// would fail every single request. It must stay false.
const appLayer = Layer.mergeAll(
  Layer.provideMerge(
    cacheLayer,
    KeyValueStore.layerStorage(() => localStorage),
  ),
  Layer.effect(LiveSlots, TxHashMap.make()),
).pipe(
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(Layer.succeed(HttpClient.TracerPropagationEnabled, false)),
);

/** Runs the plugin as one program until Logseq unloads it. */
const runMain = Runtime.makeRunMain(({ fiber, teardown }) => {
  logseq.beforeunload(() => Effect.runPromise(Fiber.interrupt(fiber)));
  fiber.addObserver((exit) => teardown(exit, () => {}));
});

// Logseq's callbacks, as streams. The macro and command hooks cannot be
// unregistered, so each is registered once, by the program below.

const macros = Stream.callback<{
  readonly slot: string;
  readonly args: ReadonlyArray<string>;
}>((queue) =>
  Effect.sync(() =>
    logseq.App.onMacroRendererSlotted(({ slot, payload }) => {
      Queue.offerUnsafe(queue, { slot, args: payload.arguments ?? [] });
    }),
  ),
);

const refreshCommands = Stream.callback<void>((queue) =>
  Effect.sync(() =>
    logseq.App.registerCommandPalette(
      { key: "pr-badges-refresh", label: "Refresh PR states" },
      () => {
        Queue.offerUnsafe(queue, undefined);
      },
    ),
  ),
);

/** The current settings, then every change. `None` while no token is set. */
const settings = Stream.concat(
  Stream.sync(() => logseq.settings),
  Stream.callback<unknown>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        logseq.onSettingsChanged((next) => {
          Queue.offerUnsafe(queue, next);
        }),
      ),
      (off) => Effect.sync(off),
    ),
  ),
).pipe(
  Stream.map((raw) => decodeSettings(raw)),
  // Logseq reports every write; only a real change is worth a new instance.
  Stream.changesWith(
    Option.makeEquivalence(
      (a, b) => a.token === b.token && a.ttlMinutes === b.ttlMinutes,
    ),
  ),
);

const program = Effect.scoped(
  Effect.gen(function* () {
    logseq.useSettingsSchema([
      {
        key: "token",
        type: "string",
        default: "",
        title: "GitHub token",
        description: "A personal access token with `repo` scope.",
      },
      {
        key: "ttlMinutes",
        type: "number",
        default: 15,
        title: "Refresh interval (minutes)",
        description:
          "How long an open or draft pull request is cached before it is checked again. Merged and closed pull requests are never re-checked.",
      },
    ]);
    logseq.provideStyle(styles);

    const liveSlots = yield* LiveSlots;
    const events = yield* PubSub.unbounded<Event>();

    // Recording a slot and parsing its slug need no settings, so they happen here,
    // once, whichever instance is running.
    yield* Effect.forkScoped(
      Stream.runForEach(macros, ({ slot, args }) => {
        const [macro, raw] = args;
        if (macro !== MACRO) return Effect.void;
        return parseRef(raw ?? "").pipe(
          Effect.tap((ref) => TxHashMap.set(liveSlots, slot, ref)),
          Effect.flatMap((ref) =>
            PubSub.publish(events, Event.Slotted({ slot, ref })),
          ),
          // The template parser's own message is generic, so name the expected form.
          Effect.catchTag("SchemaError", (e) =>
            TxHashMap.remove(liveSlots, slot).pipe(
              Effect.andThen(
                draw(
                  slot,
                  <ErrorBadge
                    message={`expected owner/repo#number: ${e.message}`}
                  />,
                ),
              ),
            ),
          ),
          logDefects,
        );
      }),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(refreshCommands, () =>
        Effect.promise(() =>
          logseq.UI.showMsg("PR states refreshing…", "success"),
        ).pipe(
          Effect.andThen(PubSub.publish(events, Event.Refresh())),
          logDefects,
        ),
      ),
    );

    // One instance per settings value. A change interrupts the running instance,
    // with its fetches and timers, and starts a new one that redraws every slot.
    yield* Stream.runDrain(
      Stream.switchMap(settings, (current) =>
        Stream.fromEffect(
          runBadges(events).pipe(Effect.provide(badgesFor(current))),
        ),
      ),
    );
  }),
).pipe(Effect.provide(appLayer));

logseq.ready(() => runMain(program)).catch(console.error);
