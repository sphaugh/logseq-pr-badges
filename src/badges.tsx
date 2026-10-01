import {
  Context,
  Data,
  Duration,
  Effect,
  FiberMap,
  Layer,
  Option,
  PubSub,
  RequestResolver,
  Schedule,
  TxHashMap,
} from "effect";
import type { VNode } from "preact";
import { render } from "preact-render-to-string";
import { Badge, ErrorBadge, FallbackLink, Skeleton } from "./badge";
import { Cache, type CacheEntry, CacheEntrySchema, isFresh } from "./cache";
import {
  GetPr,
  GitHubToken,
  isRetryable,
  makeResolver,
  messageFor,
  NotFound,
  retryPolicy,
} from "./github";
import type { PrRef } from "./ref";
import { Settings } from "./settings";

const BATCH_WINDOW = Duration.millis(50);
const NOT_FOUND_TTL = Duration.minutes(5);

/** The one place markup becomes HTML: `provideUI` takes a string, and nothing hydrates. */
export const draw = (slot: string, ui: VNode) =>
  Effect.sync(() =>
    logseq.provideUI({
      key: `pr-${slot}`,
      slot,
      template: render(ui),
      reset: true,
    }),
  );

/** Logseq never reports a macro unmounting, so ask the host whether the slot is still
 *  there. A failed check counts as mounted: keeping a dead slot costs a no-op paint,
 *  dropping a live one loses its badge. */
const isUnmounted = (slot: string) =>
  Effect.tryPromise(() => logseq.UI.checkSlotValid(slot)).pipe(
    Effect.map((valid) => !valid),
    Effect.orElseSucceed(() => false),
  );

/** Logs a defect and carries on. Nothing awaits a forked fiber or a stream handler,
 *  so a defect would otherwise vanish silently, or stop every later event with it. */
export function logDefects<A, E, R>(self: Effect.Effect<A, E, R>) {
  return self.pipe(
    Effect.catchDefect((defect) =>
      Effect.logError("logseq-pr-badges: unexpected failure", defect),
    ),
  );
}

/** slot -> ref for every slot showing a badge. It outlives any one instance of
 *  `Badges`, so the instance a settings change starts knows what to redraw. */
export class LiveSlots extends Context.Service<
  LiveSlots,
  TxHashMap.TxHashMap<string, PrRef>
>()("logseq-pr-badges/LiveSlots") {}

/** What the host reports to the running instance. */
export type Event = Data.TaggedEnum<{
  Slotted: { readonly slot: string; readonly ref: PrRef };
  Refresh: Record<never, never>;
}>;
export const Event = Data.taggedEnum<Event>();

/** What is already known about a PR when its macro is slotted. */
type Lookup = Data.TaggedEnum<{
  Fresh: { readonly entry: CacheEntry };
  Stale: { readonly entry: CacheEntry };
  RecentlyMissed: Record<never, never>;
  Unseen: Record<never, never>;
}>;
const Lookup = Data.taggedEnum<Lookup>();

/** Draws and fetches badges for one set of settings. A settings change replaces the
 *  whole instance, so inside it the settings never change. */
export class Badges extends Context.Service<
  Badges,
  {
    readonly handleMacro: (slot: string, ref: PrRef) => Effect.Effect<void>;
    /** Re-fetch every PR on screen, for the refresh command. */
    readonly refreshAll: Effect.Effect<void>;
  }
>()("logseq-pr-badges/Badges", {
  make: Effect.gen(function* () {
    const cache = yield* Cache;
    const { ttlMinutes } = yield* Settings;
    const ttl = Duration.toMillis(Duration.minutes(ttlMinutes));

    // One resolver for the instance's lifetime. The batch window is what gathers a
    // page's worth of macros, each slotted in its own host callback, into one query.
    const resolver = RequestResolver.setDelay(
      yield* makeResolver,
      BATCH_WINDOW,
    );

    const liveSlots = yield* LiveSlots;
    /** PRs that came back not-found, keyed by `ref.key`, with when we learned that. */
    const notFound = yield* TxHashMap.make<string, number>();
    /** One fetch fiber per PR, so a PR on several blocks is fetched once. All are
     *  interrupted, timers included, when the instance stops. */
    const fetches = yield* FiberMap.make<string>();

    const pruneUnmounted = TxHashMap.keys(liveSlots).pipe(
      Effect.flatMap(Effect.filter(isUnmounted, { concurrency: "unbounded" })),
      Effect.flatMap((dead) => TxHashMap.removeMany(liveSlots, dead)),
    );

    const redraw = (ref: PrRef, ui: VNode) =>
      liveSlots.pipe(
        TxHashMap.filter((r) => r.key === ref.key),
        // biome-ignore lint/suspicious/useIterableCallbackReturn: TxHashMap.forEach, not Array#forEach; the callback must return an Effect.
        Effect.flatMap(TxHashMap.forEach((_, slot) => draw(slot, ui))),
      );

    const drawBadge = (ref: PrRef, entry: CacheEntry, stale: boolean) =>
      redraw(ref, <Badge entry={entry} refKey={ref.key} stale={stale} />);

    const drawSkeleton = (ref: PrRef) =>
      redraw(ref, <Skeleton refKey={ref.key} />);

    const drawError = (ref: PrRef, message: string) =>
      redraw(ref, <ErrorBadge message={message} />);

    /** Prefer the last-known state, dimmed. With nothing cached there is nothing to
     *  dim, so link out to the PR itself rather than showing a bare error. */
    const drawDegraded = (ref: PrRef, message: string) =>
      cache.get(ref.key).pipe(
        Effect.map(
          Option.match({
            onSome: (entry) => <Badge entry={entry} refKey={ref.key} stale />,
            onNone: () => (
              <FallbackLink refKey={ref.key} url={ref.url} message={message} />
            ),
          }),
        ),
        Effect.flatMap((ui) => redraw(ref, ui)),
      );

    const fetchKey = (ref: PrRef) =>
      Effect.gen(function* () {
        const prData = yield* Effect.request(new GetPr({ ref }), resolver).pipe(
          Effect.retry({
            schedule: retryPolicy.pipe(
              Schedule.tap(({ input }) =>
                input._tag === "RateLimited"
                  ? drawDegraded(ref, messageFor(input))
                  : Effect.void,
              ),
            ),
            while: isRetryable,
          }),
        );

        const entry = CacheEntrySchema.make({
          ...prData,
          fetchedAt: Date.now(),
        });
        yield* cache.set(ref.key, entry);
        yield* drawBadge(ref, entry, false);
      }).pipe(
        Effect.catchTag("NotFound", (error) =>
          TxHashMap.set(notFound, ref.key, Date.now()).pipe(
            Effect.andThen(drawError(ref, messageFor(error))),
          ),
        ),
        Effect.catch((error) => drawDegraded(ref, messageFor(error))),
      );

    const startFetch = (ref: PrRef) =>
      FiberMap.run(fetches, ref.key, logDefects(fetchKey(ref)), {
        onlyIfMissing: true,
      });

    const lookup = (ref: PrRef) =>
      Effect.gen(function* () {
        const cached = yield* cache.get(ref.key);
        if (Option.isSome(cached)) {
          return isFresh(cached.value, Date.now(), ttl)
            ? Lookup.Fresh({ entry: cached.value })
            : Lookup.Stale({ entry: cached.value });
        }

        const missedAt = yield* TxHashMap.get(notFound, ref.key);
        const recentlyMissed = Option.exists(
          missedAt,
          (at) => Date.now() - at < Duration.toMillis(NOT_FOUND_TTL),
        );
        return recentlyMissed ? Lookup.RecentlyMissed() : Lookup.Unseen();
      });

    // The slot is already in `liveSlots`, and every draw goes to all of a PR's slots.
    const handleMacro = (_slot: string, ref: PrRef) =>
      lookup(ref).pipe(
        Effect.flatMap(
          Lookup.$match({
            Fresh: ({ entry }) => drawBadge(ref, entry, false),
            Stale: ({ entry }) =>
              drawBadge(ref, entry, true).pipe(Effect.andThen(startFetch(ref))),
            RecentlyMissed: () =>
              drawError(ref, messageFor(new NotFound({ key: ref.key }))),
            Unseen: () =>
              drawSkeleton(ref).pipe(Effect.andThen(startFetch(ref))),
          }),
        ),
        Effect.asVoid,
      );

    const refreshAll = Effect.gen(function* () {
      yield* TxHashMap.clear(notFound);

      // Only refetch PRs still on screen.
      yield* pruneUnmounted;

      // `onlyIfMissing` fetches each PR once however many slots show it.
      yield* TxHashMap.forEach(liveSlots, startFetch);
    });

    return { handleMacro, refreshAll };
  }),
}) {}

/** Runs while no token is set: nothing can be fetched, so every badge says so. */
export const NoTokenBadges = Layer.effect(
  Badges,
  Effect.gen(function* () {
    const liveSlots = yield* LiveSlots;
    const drawNoToken = (slot: string) =>
      draw(
        slot,
        <ErrorBadge message="no GitHub token set — add one in the PR Badges plugin settings" />,
      );
    return {
      handleMacro: drawNoToken,
      refreshAll: TxHashMap.forEach(liveSlots, (_, slot) => drawNoToken(slot)),
    };
  }),
);

/** The instance for one value of the settings, `None` meaning no token is set. */
export const badgesFor = Option.match({
  onNone: () => NoTokenBadges,
  onSome: (settings: Settings["Service"]) =>
    Layer.effect(Badges, Badges.make).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Settings, settings),
          Layer.succeed(GitHubToken, settings.token),
        ),
      ),
    ),
});

/** Runs one instance until a settings change interrupts it: catch up on every slot
 *  already on screen, then handle events as they arrive. */
export const runBadges = (events: PubSub.PubSub<Event>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const badges = yield* Badges;
      const liveSlots = yield* LiveSlots;

      // Subscribe before catching up, so a macro slotted in between is not missed.
      const subscription = yield* PubSub.subscribe(events);
      yield* TxHashMap.forEach(liveSlots, (ref, slot) =>
        badges.handleMacro(slot, ref),
      );

      return yield* Effect.forever(
        PubSub.take(subscription).pipe(
          Effect.flatMap(
            Event.$match({
              Slotted: ({ slot, ref }) => badges.handleMacro(slot, ref),
              Refresh: () => badges.refreshAll,
            }),
          ),
          logDefects,
        ),
      );
    }),
  );
