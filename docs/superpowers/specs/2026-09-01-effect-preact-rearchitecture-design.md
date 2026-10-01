# logseq-pr-badges on Effect v4 + Preact — Design

**Date:** 2026-09-01
**Status:** Approved, pending implementation plan
**Supersedes:** nothing. The behavioural spec
`2026-08-29-logseq-pr-badges-design.md` remains in force, unchanged.

## Why

The plugin shipped and works: `main` @ `41678dc`, 66 tests green, reviewed. This
rearchitecture is not driven by a defect. It is driven by two observations about the
shipped code that turned out to be correct:

1. **`cache.get` hand-rolls validation.** It duplicates the `PrState` union as a
   runtime `STATES` array that nothing keeps in sync, performs five type guards, and
   ends in an `as PrState` cast. The final whole-branch review found that this
   whitelist is *load-bearing* for `badge.ts`'s deliberately-unescaped
   `data-state="${entry.state}"` interpolation. So the one place the codebase
   hand-rolls validation is the place a downstream module silently depends on for
   its safety.
2. **HTML is assembled from template strings** with a hand-rolled `escapeHtml`. That
   is exactly where this project shipped a security bug: `renderBadge` escaped
   `entry.url` but did not check its scheme, so a `javascript:` URL became an
   executable `href`. Escaping and markup construction being manual is the
   underlying condition.

Effect's Schema addresses (1) at its root by deriving the runtime check and the type
from one declaration. Preact's JSX addresses (2) by making escaping structural
rather than a function someone must remember to call.

## What does not change

Every behavioural requirement of the existing spec:

- Macro syntax is exactly `{{pr owner/repo#number}}`; no defaults, no bare numbers,
  no URL form.
- The plugin never writes to a Logseq block.
- PR titles live only in the cache, never in the markdown.
- Terminal states (`merged`, `closed`) cached forever; `open`/`draft` expire on a TTL
  (default 15 minutes).
- Every render path produces visible output. Never a blank, never an error box.
- A corrupt cache entry reads as a miss and never propagates.
- Cache keys are prefixed `logseq-pr-badges:v1:`.
- The badge renders an `href` only for `https:` URLs.
- The token is never logged, echoed, persisted by us, or rendered.

A behavioural regression is the only way this work can fail. The existing 66 tests
are the net.

## Decisions

| Decision | Choice |
|---|---|
| Effect version | `effect@4.0.0-rc.112` (the `rc` tag, ahead of the `beta` in the v4 announcement) |
| Scope of Effect | Full: core `Schema`, `unstable/persistence` `KeyValueStore`, `RequestResolver`, `Schedule` |
| Runtime shape | `ManagedRuntime` built once at init; Logseq callbacks run Effects at the boundary |
| Render layer | Preact + `preact-render-to-string` |
| Tests | `@effect/vitest@4.0.0-rc.112` with `TestClock` |
| Migration | Incremental on a branch, suite green at every commit |

The daemon-fiber-plus-Queue alternative was considered and rejected in favour of the
callback-driven `ManagedRuntime`: it would have deleted more hand-rolled scheduling,
but it also restructures the exact control flow that was reviewed line-by-line last
session. The conservative shape keeps the existing tests meaningful as a behavioural
net, which is the priority for a rewrite of working code.

## Verified mechanics

Confirmed against `effect@4.0.0-rc.112` and `preact-render-to-string@6.7.0` on
2026-09-01, by installing and building, not from memory. Several contradict the v3
documentation and the v4 announcement post.

**1. `Schema` is stable and lives at the package root.** `import { Schema } from
'effect'`. `effect/unstable/schema` is a *different* module containing `Model` and
`VariantSchema`, not the core Schema — an easy and costly confusion.

**2. `RequestResolver.makeBatched` does not exist in v4.** The v4 surface is
`make`, `makeWith`, `makeGrouped`, `batchN`, `around`. Any v3 example using
`makeBatched` must be translated.

**3. `RequestResolver` batches within a single Effect execution, not across
independent runtime invocations.** Because each Logseq callback is its own
`runPromise`, refs arriving from separate `onMacroRendererSlotted` firings will not
group on their own. **The `pending` map and the 50 ms debounce timer therefore
survive**; each flush issues one `Effect.forEach(batch, request, { batching: true })`.
The resolver buys dedup and a clean batching abstraction — not the deletion of the
scheduling code. Expecting otherwise is the single most likely source of a wasted day
on this project.

**4. `toSchemaStore().get` fails the Effect on a decode error.** Its implementation is
`Effect.flatMap(self.get(key), UndefinedOr.match({ onUndefined: () => Effect.succeedNone,
onDefined: value => Effect.asSome(decode(value)) }))`. A corrupt stored value produces
a *failure*, not `None`. Since "a corrupt entry reads as a miss" is a binding
requirement, every read must be wrapped — `Effect.orElseSucceed(() => Option.none())`
or equivalent. This is not optional.

**5. v4's JSON codec names differ from v3.** `toSchemaStore` uses
`Schema.toCodecJson` and `Schema.fromJsonString`. v3's `Schema.parseJson` is gone.

**6. Preact escapes children and attribute values; it does not block dangerous URL
schemes.** Verified output for `<a href="javascript:alert(1)" title={'" onmouseover="x'}>`
with a `<script>` child:

    <a href="javascript:alert(1)" title="&quot; onmouseover=&quot;x"><span>&lt;script>alert(1)&lt;/script></span></a>

So JSX eliminates the manual-escaping bug class and **not** the scheme bug class.
`safeHref` must survive the migration. Deleting it because "JSX is safe" reintroduces
the exact vulnerability this project already shipped once.

**7. Measured bundle cost** (vite, esbuild minify, `lib` mode):

| Bundle | min | gzip |
|---|---|---|
| Current whole plugin | 100.0 kB | 35.6 kB |
| Effect **v3** Schema, one decoder | 240.0 kB | 59.7 kB |
| Effect **v4** Schema, same decoder | 81.2 kB | 22.0 kB |
| Preact + `preact-render-to-string` | 10.7 kB | 4.0 kB |

v4 is a ~3x reduction on v3 and closely matches the announcement's claim. The
projected total is roughly 58 kB gzip. For a plugin loaded from local disk into an
already-running Electron renderer this is immaterial; it is recorded so nobody
relitigates it from instinct.

**8. `KeyValueStore` is at `effect/unstable/persistence`**, exposing `layerStorage`
(Web Storage), `layerMemory`, `layerFileSystem`, `layerSql`, `prefix`, `make`,
`makeStringOnly`, `toSchemaStore`. `@effect/platform` has **no** 4.x release; the v3
`@effect/platform-browser` `BrowserKeyValueStore` is not available to us.

**9. Schema API names, confirmed by a compiling build:** `Schema.Struct`,
`Schema.Literals([...])` (plural), `Schema.String`, `Schema.Finite`,
`Schema.decodeUnknownOption` (synchronous, returns `Option`), `Schema.decodeEffect`.

**10. `effect/testing` ships in-package**: `TestClock`, `TestConsole`, `TestSchema`,
`FastCheck`. `@effect/vitest` has an `rc` tag version-matched to `effect`'s own.

## Module design

### `src/ref.ts` — unchanged, deliberately

A regex parse into a three-field struct gains nothing from Schema; introducing it
here would be ceremony. `parseRef` keeps returning a plain discriminated union and
stays synchronous and total. Its 13 tests port unmodified.

This is the one module where Effect is the wrong tool, and saying so explicitly is
part of the design.

### `src/cache.ts` — mostly deleted

```ts
const PrStateSchema = Schema.Literals(['open', 'draft', 'merged', 'closed'])
export type PrState = typeof PrStateSchema.Type

const CacheEntrySchema = Schema.Struct({
  state: PrStateSchema,
  title: Schema.String,
  url: Schema.String,
  fetchedAt: Schema.Finite,
})
```

The store is `KeyValueStore.layerStorage(localStorage)` composed with
`prefix('logseq-pr-badges:v1:')` and `toSchemaStore(CacheEntrySchema)`, with every
read wrapped so a decode failure yields `Option.none()` (Verified mechanics #4).

Deleted: both `try`/`catch` blocks, the `JSON.parse`, five type guards, the prefix
concatenation, the `STATES` array, and the `as PrState` cast.

`PrState` is now *derived from* the schema rather than declared twice. This is the
DRY defect the rearchitecture exists to fix, and it also removes the manual
synchronisation that `badge.ts` implicitly relies on.

`isFresh` and `isTerminal` stay as pure functions over a decoded entry — they are
already correct and need no effect context. `DEFAULT_TTL_MS` stays.

`PrState` moving from `github.ts` to `cache.ts` reverses one import edge. The
resulting graph — `ref` and `cache` import nothing; `github` imports both; `badge`
imports `cache`; `index` imports all — is still acyclic. Note `cache` does not import
`ref`: it is keyed by plain strings, so there is no dependency in that direction.

### `src/github.ts` — a service with tagged errors

`FetchOutcome` — a hand-rolled `Either` with a `kind` string discriminant — becomes
`Data.TaggedError` subclasses:

```ts
class NotFound      extends Data.TaggedError('NotFound')<{ key: string }> {}
class AuthFailed    extends Data.TaggedError('AuthFailed')<{ status: number }> {}
class RateLimited   extends Data.TaggedError('RateLimited')<{ retryAfterMs: number }> {}
class NetworkFailed extends Data.TaggedError('NetworkFailed')<{ message: string }> {}
class QueryFailed   extends Data.TaggedError('QueryFailed')<{ message: string }> {}
```

so the signature is `Effect<PrData, PrError>` and the current `if (outcome.kind ===
...)` chains become exhaustive `Effect.catchTag`. `QueryFailed` covers the
top-level-`errors`-without-`data` case that the shipped code initially mis-reported
as `NotFound`; the distinction is now enforced by the type rather than by a guard.

Batching uses `Effect.request` against a `RequestResolver` built with `make`/`batchN`
(Verified mechanics #2), driven from `flush` with `{ batching: true }` (#3).

Retry uses `Schedule.exponential('1 second')` piped through `Schedule.jittered`,
applied only to `RateLimited` and `NetworkFailed`. The cross-flush rate-limit window
stays as an explicit `Ref<number>`, exactly as `rateLimitedUntil` works today —
`Schedule` governs retries *within* one flush, and the window that suppresses the
*next* flush is separate state either way. v4's `RateLimiter` in
`unstable/persistence` might absorb it, but that is a follow-up to evaluate after
this lands, not a choice to make mid-implementation.

`buildQuery` and `deriveState` stay pure and keep their tests.

### `src/badge.ts` → `src/badge.tsx` — Preact components

Exported components: `<Badge entry refKey stale>`, `<Skeleton refKey>`,
`<ErrorBadge message>`, `<FallbackLink refKey url message>`. The four octicons become
real inline `<svg><path d="…"/></svg>` JSX instead of a `Record<PrState, string>` of
path data.

`escapeHtml` is deleted; Preact escapes children and attribute values structurally.
**`safeHref` survives unchanged** (Verified mechanics #6).

The module exports thin `renderX(...)` wrappers that call
`preact-render-to-string`'s `render`, so `index.ts`'s call sites keep taking strings
and `provideUI` is untouched. Colours stay in the stylesheet keyed off `data-state`;
no colour values enter this module.

### `src/index.ts` — `ManagedRuntime`

`main()` builds the layer stack once — the storage-backed schema store, the GitHub
client, and a token service — and creates a `ManagedRuntime`. Callbacks run Effects
at the boundary: `runSync` for the synchronous cache-hit draw that keeps reload
flash-free, `runPromise` for flushes.

`liveSlots`, `pending`, `notFound` and `rateLimitedUntil` become `Ref`s rather than
module-level mutable bindings, which also makes them reachable from tests.

The token is read from `logseq.settings` into a `Ref` refreshed by
`onSettingsChanged`, so the client reads a service rather than touching the host API
mid-effect.

`handleMacro`, `flush`, `scheduleFlush`, `draw`, `redrawKey` and `requeueAllLive`
keep their current shapes and responsibilities. That is the point of the chosen
runtime shape: the reviewed control flow survives, and only the primitives beneath it
change.

## Testing

`@effect/vitest@rc` with `it.effect`. `TestClock` replaces injected-`now` arithmetic,
which finally makes the retry `Schedule` and the TTL boundary testable as behaviour
rather than as clock math. `KeyValueStore.layerMemory` replaces the hand-rolled
`MemoryStorage` stub.

Per module:

- **`ref.ts`** — 13 tests port unmodified. No Effect involvement.
- **`cache.ts`** — rewritten. The five type-guard tests collapse into one schema
  round-trip plus a decode-failure test asserting `Option.none()` (the wrap from
  Verified mechanics #4). TTL and terminal pinning move to `TestClock.adjust`.
- **`github.ts`** — `buildQuery`/`deriveState` tests port nearly unchanged. Error
  classification tests assert tagged errors instead of `kind` strings. The retry
  `Schedule` gains real coverage via `TestClock`; the `x-ratelimit-reset` path, which
  shipped untested, gets a test.
- **`badge.tsx`** — rewritten against rendered component output. The escaping tests
  stay, since they assert the *output* contract and are exactly what must not
  regress. The `javascript:` scheme test stays and becomes more important, because
  the surrounding escaping is now implicit.
- **`index.ts`** — still no unit tests; still verified by reasoning at review, and by
  the manual GUI checklist.

Every existing behavioural assertion must survive in some form. A test deleted
without a named replacement is a regression in disguise.

## Migration order

Incremental, suite green and `pnpm build` succeeding at each commit:

1. Dependencies and Vite JSX configuration.
2. `badge.tsx` — self-contained, no Effect, immediately verifiable.
3. `cache.ts` — Schema plus `KeyValueStore`; the `PrState` import edge reverses here.
4. `github.ts` — tagged errors, `RequestResolver`, `Schedule`.
5. `index.ts` — `ManagedRuntime`, `Ref`s, boundary runners.

`badge.tsx` goes first deliberately: it delivers the JSX win with zero Effect risk,
so if the Effect migration stalls the branch still holds something worth keeping.

One ordering consequence: at step 2, `PrState` still lives in `github.ts`, so
`badge.tsx` imports it from there and step 3 updates that one import when the type
moves to `cache.ts`. Expected, not a mistake to correct in step 2.

## Risks

1. **`effect@rc` is a release candidate.** API churn before 4.0 final is likely.
2. **`unstable/persistence` is explicitly unstable**, and `KeyValueStore` is our most
   exposed dependency on it. If it breaks, the fallback is the current hand-rolled
   store behind the same interface — worth keeping in mind when shaping that
   interface.
3. **`toSchemaStore` failure semantics** contradict our binding requirement and must
   be wrapped. Recorded as Verified mechanics #4 rather than left to discovery.
4. **`safeHref` deletion** is the most likely way to reintroduce a known
   vulnerability. It is called out in the design, the module section, and the tests.
5. **This replaces reviewed, working code.** Behaviour preservation is the whole job;
   the 66 tests are the net, and no assertion should disappear without a replacement.
