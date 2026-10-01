# Effect v4 + Preact Rearchitecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the working plugin's validation onto Effect v4 `Schema` + `KeyValueStore`, its fetch/retry onto `RequestResolver` + `Schedule`, and its HTML onto Preact JSX — with zero behavioural change.

**Architecture:** A `ManagedRuntime` built once at plugin init holds the layer stack; Logseq's callbacks run Effects at the boundary (`runSync` for the synchronous cache-hit draw, `runPromise` for flushes). The reviewed control flow in `index.ts` survives; only the primitives beneath it change. Rendering moves to Preact components rendered to strings, because `provideUI` takes an HTML string and nothing hydrates.

**Tech Stack:** TypeScript, Vite 7, Vitest 4, `effect@4.0.0-rc.112`, `@effect/vitest@4.0.0-rc.112`, `preact`, `preact-render-to-string`, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-01-effect-preact-rearchitecture-design.md`
**Behavioural spec (still binding):** `docs/superpowers/specs/2026-08-29-logseq-pr-badges-design.md`

## Global Constraints

- **Zero behavioural change.** Every requirement of the behavioural spec holds: macro syntax `{{pr owner/repo#number}}`; no block writes; titles only in the cache; terminal states cached forever, open/draft on a TTL (default 15 min); every render path visibly outputs something; a corrupt cache entry reads as a miss; keys prefixed `logseq-pr-badges:v1:`; `href` only for `https:` URLs; the token never logged, rendered, or persisted by us.
- **No test assertion may disappear without a named replacement.** The 66 existing tests are the regression net for a rewrite of working code.
- `safeHref` **survives**. Preact escapes values but does not block dangerous URL schemes.
- Module import direction after Task 4: `ref` and `cache` import nothing, `github` imports both, `badge` imports `cache`, `index` imports all. Acyclic. `cache` never imports `ref`.
- `ref.ts` is not touched. A regex parse gains nothing from Schema.
- Exact dependency versions: `effect@4.0.0-rc.112`, `@effect/vitest@4.0.0-rc.112`, `vite@^7`, `vitest@^4.1`, `preact@^10.29.8`, `preact-render-to-string@^6.7.0`.

### Verified mechanics — read before writing any code

All confirmed on 2026-09-01 by installing the packages and running code, not from documentation. Items 1-6 contradict v3 examples or the v4 announcement, and each one costs real time to rediscover.

1. **`@effect/vitest@rc` requires `vitest >=4.1.0 <5.0.0`, which requires `vite ^6||^7||^8`.** The project is on `vitest@2.1.9` and `vite@5.4.21`, so this migration includes a two-major test-runner bump and a Vite major bump. **The spec did not anticipate this.** Verified working combination: `vite@7.3.6` + `vitest@4.1.11` + both rc packages.
2. **`Effect.Service` does not exist in v4.** Define services as `Context.Service<Interface, Interface>('name')` and build layers with `Layer.effect(Tag)(effect)` (curried). This is how `KeyValueStore` itself is declared.
3. **`{ batching: true }` alone does NOT batch.** `Effect.forEach(keys, f, { batching: true })` runs sequentially, producing one resolver invocation *per request*. Batching requires concurrency: `Effect.forEach(keys, f, { batching: true, concurrency: 'unbounded' })`. Measured: without concurrency the resolver ran 4 times for 4 requests; with it, once. Getting this wrong means one GraphQL request per badge instead of one per flush — a silent 25x regression that no existing test would catch.
4. **`toSchemaStore().get` fails the Effect on a decode error** rather than returning `None`. Every read must be wrapped: `Effect.orElseSucceed(() => Option.none())`. Non-optional, since "a corrupt entry reads as a miss" is binding.
5. **`store.set` can fail** with `KeyValueStoreError | SchemaError`. The shipped code deliberately swallows write failures ("best-effort"), so wrap with `Effect.ignore` or you change behaviour.
6. **`Effect.fork` does not exist in v4** — use `Effect.forkChild` (also `forkDetach`, `forkIn`, `forkScoped`).
7. **A time-based `Schedule` under `it.effect` hangs**, because `it.effect` supplies a `TestClock` that never advances on its own. Fork the retry with `Effect.forkChild`, `yield* TestClock.adjust(...)`, then `Fiber.join`.
8. **`entry.completeUnsafe` takes an `Exit`**, not an `Effect`: `Exit.succeed(v)` / `Exit.fail(e)`.
9. **`RequestResolver` does not group across separate runtime invocations** — only within one Effect execution. Since each Logseq callback is its own run, the `pending` map and 50 ms debounce timer survive.
10. Read the TestClock's time with `Effect.clockWith((c) => c.currentTimeMillis)`.
11. Test wiring: `Layer.provideMerge(cacheLayer, KeyValueStore.layerMemory)`.
12. **Preact's serialization will not be byte-identical** to the current hand-built strings (self-closing tags, attribute order). Assert on structure and content — `toContain`, parsed attributes — never on exact HTML equality.

---

## File Structure

| File | Change | Responsibility after |
|---|---|---|
| `package.json` | modify | New deps and exact versions |
| `vite.config.ts` | modify | Preact JSX via esbuild; Vitest 4 config |
| `tsconfig.json` | modify | `jsx: "react-jsx"`, `jsxImportSource: "preact"` |
| `src/ref.ts` | **untouched** | Regex ref parsing. Plain, synchronous, total |
| `src/ref.test.ts` | **untouched** | 13 tests. `ref.ts` does not change, so neither do its imports |
| `src/badge.ts` → `src/badge.tsx` | rewrite | Preact components + string-render wrappers. Same four exported signatures |
| `src/badge.test.ts` → `src/badge.test.tsx` | rewrite | Output-contract tests incl. escaping and scheme |
| `src/cache.ts` | rewrite | Schema, `KeyValueStore` service, TTL predicates |
| `src/cache.test.ts` | rewrite | `it.effect` + `layerMemory` + `TestClock` |
| `src/github.ts` | rewrite | Tagged errors, `RequestResolver`, `Schedule` |
| `src/github.test.ts` | rewrite | Tagged-error assertions, batch-count assertions |
| `src/index.ts` | rewrite | `ManagedRuntime`, `Ref`s, boundary runners |

---

## Task 1: Toolchain bump only — Vite 7 and Vitest 4

Deliberately isolated. This changes no product code, so if the runner bump breaks something it fails on its own and is reviewable on its own. **The 66 existing tests must still pass unchanged at the end of this task.**

**Files:**
- Modify: `package.json`, `vite.config.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a repo on Vite 7 / Vitest 4 with the original 66 tests green

- [ ] **Step 1: Record the baseline**

```bash
cd ~/devel/logseq-pr-badges
pnpm test 2>&1 | tail -5
```
Expected: `Test Files 4 passed (4)`, `Tests 66 passed (66)`. Write the numbers into your report — this is the figure every later task is measured against.

- [ ] **Step 2: Bump the runner and bundler**

```bash
pnpm add -D vite@^7 vitest@^4.1
```

- [ ] **Step 3: Run the suite**

Run: `pnpm test`
Expected: 66 passed. If anything fails, it is a Vitest 3/4 breaking change in our usage — the suite only uses `describe`/`it`/`expect`/`vi.fn`, so the likely culprits are config shape or the `test` key's position. Fix the config, not the tests.

- [ ] **Step 4: Verify typecheck and build**

```bash
pnpm typecheck
pnpm build
ls -l dist/index.html
```
Expected: clean typecheck; `dist/index.html` produced. Vite 7 may warn about `build.target`; a warning is acceptable, an error is not.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml vite.config.ts
git commit -m "build: bump to vite 7 and vitest 4

Required by @effect/vitest@4.0.0-rc.112, which peer-depends on
vitest >=4.1.0, which in turn requires vite ^6||^7||^8. Isolated from
the rearchitecture so a runner regression is reviewable on its own.
All 66 existing tests unchanged and passing."
```

---

## Task 2: Add Effect and Preact, wire JSX

Still no product-code change. Ends with the new dependencies installed, JSX compiling, and the same 66 tests green.

**Files:**
- Modify: `package.json`, `vite.config.ts`, `tsconfig.json`
- Create: `src/jsx-probe.test.tsx` (deleted in Task 3)

**Interfaces:**
- Consumes: Task 1's toolchain
- Produces: `effect`, `@effect/vitest`, `preact`, `preact-render-to-string` available; `.tsx` files compile and run under Vitest

- [ ] **Step 1: Install**

```bash
pnpm add effect@4.0.0-rc.112 preact@^10.29.8 preact-render-to-string@^6.7.0
pnpm add -D @effect/vitest@4.0.0-rc.112
```

- [ ] **Step 2: Add JSX to `tsconfig.json`**

Add these two keys inside `compilerOptions`:

```json
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
```

- [ ] **Step 3: Write a failing JSX probe**

Create `src/jsx-probe.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest'
import { render } from 'preact-render-to-string'

describe('jsx toolchain', () => {
  it('renders a component to a string and escapes children', () => {
    const C = ({ t }: { t: string }) => <span class="x">{t}</span>
    expect(render(<C t="<script>" />)).toBe('<span class="x">&lt;script></span>')
  })
})
```

- [ ] **Step 4: Run it and watch it fail or pass for the right reason**

Run: `pnpm vitest run src/jsx-probe.test.tsx`
Expected: PASS. If it fails with a JSX transform error, the `tsconfig` keys from Step 2 are missing or Vite is not picking them up — Vite 7 reads `tsconfig`'s `jsx` settings via esbuild, so no `vite.config.ts` change should be needed. Only if that fails, add to `vite.config.ts`:

```ts
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
```

- [ ] **Step 5: Confirm nothing else regressed**

```bash
pnpm test
pnpm typecheck
pnpm build
```
Expected: 67 tests (66 + the probe), clean typecheck, `dist/index.html` produced.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "build: add effect v4 rc, preact, and JSX compilation

No product code changed. The JSX probe test proves the toolchain
compiles .tsx and that Preact escapes children; Task 3 deletes it."
```

---

## Task 3: `badge.tsx` — Preact components

**Files:**
- Create: `src/badge.tsx`
- Delete: `src/badge.ts`, `src/badge.test.ts`, `src/jsx-probe.test.tsx`
- Create: `src/badge.test.tsx`

**Interfaces:**
- Consumes: `CacheEntry` from `./cache`, `PrState` from `./github` (still there — it moves in Task 4)
- Produces — **exactly the same four signatures as today, so `index.ts` needs no change**:
  - `renderBadge(entry: CacheEntry, refKey: string, opts: { stale: boolean }): string`
  - `renderSkeleton(refKey: string): string`
  - `renderError(message: string): string`
  - `renderFallbackLink(refKey: string, url: string, message: string): string`
  - `safeHref(url: string): { href?: string }` (exported for its own test)
  - `escapeHtml` is **removed** — Preact escapes structurally

- [ ] **Step 1: Write the failing tests**

Create `src/badge.test.tsx`. Note the assertions are structural, not byte-exact — Preact's serialization differs from the old hand-built strings (Verified mechanics #12).

```tsx
import { describe, it, expect } from 'vitest'
import { renderBadge, renderSkeleton, renderError, renderFallbackLink, safeHref } from './badge'
import type { CacheEntry } from './cache'

const entry = (o: Partial<CacheEntry> = {}): CacheEntry => ({
  state: 'merged',
  title: 'EMB-2887: Bringup and service rootfs',
  url: 'https://github.com/avride/av/pull/36812',
  fetchedAt: 0,
  ...o,
})

describe('safeHref', () => {
  it('returns an href prop for https', () => {
    expect(safeHref('https://x.test/1')).toEqual({ href: 'https://x.test/1' })
  })
  it('returns no href prop for any other scheme', () => {
    expect(safeHref('javascript:alert(1)')).toEqual({})
    expect(safeHref('JavaScript:alert(1)')).toEqual({})
    expect(safeHref('  https://x.test/1')).toEqual({})
    expect(safeHref('http://x.test/1')).toEqual({})
    expect(safeHref('data:text/html,x')).toEqual({})
  })
})

describe('renderBadge', () => {
  it('carries the state as a data attribute', () => {
    expect(renderBadge(entry(), 'avride/av#36812', { stale: false }))
      .toContain('data-state="merged"')
  })

  it('links to the pull request and opens outside Logseq', () => {
    const html = renderBadge(entry(), 'avride/av#36812', { stale: false })
    expect(html).toContain('href="https://github.com/avride/av/pull/36812"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('shows the title', () => {
    expect(renderBadge(entry(), 'avride/av#36812', { stale: false }))
      .toContain('EMB-2887: Bringup and service rootfs')
  })

  it('escapes a hostile title', () => {
    const html = renderBadge(entry({ title: '<script>alert(1)</script>' }), 'k', { stale: false })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script>')
  })

  it('escapes a hostile tooltip', () => {
    const html = renderBadge(entry(), 'a/b#1" onmouseover="x', { stale: false })
    expect(html).not.toContain('onmouseover="x"')
    expect(html).toContain('&quot;')
  })

  it('drops the href for a non-https url so javascript: cannot execute', () => {
    const html = renderBadge(entry({ url: 'javascript:alert(1)' }), 'k', { stale: false })
    expect(html).not.toContain('href')
    expect(html).not.toContain('javascript:')
  })

  it('marks a stale badge and omits the marker when fresh', () => {
    expect(renderBadge(entry(), 'k', { stale: true })).toContain('data-stale="true"')
    expect(renderBadge(entry(), 'k', { stale: false })).not.toContain('data-stale')
  })

  it('renders a distinct icon per state', () => {
    const all = (['open', 'draft', 'merged', 'closed'] as const)
      .map((s) => renderBadge(entry({ state: s }), 'k', { stale: false }))
    expect(new Set(all).size).toBe(4)
  })

  it('names the state and ref in the tooltip', () => {
    const html = renderBadge(entry(), 'avride/av#36812', { stale: false })
    expect(html).toContain('merged')
    expect(html).toContain('avride/av#36812')
  })

  it('emits no colour values — those live in the stylesheet', () => {
    const html = renderBadge(entry(), 'k', { stale: false })
    expect(html).not.toMatch(/#[0-9a-f]{6}/i)
  })
})

describe('renderSkeleton', () => {
  it('marks itself busy and shows the ref', () => {
    const html = renderSkeleton('avride/av#36812')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('avride/av#36812')
  })
})

describe('renderError', () => {
  it('shows a warning sign and escapes the message', () => {
    const html = renderError('bad <ref>')
    expect(html).toContain('⚠')
    expect(html).toContain('&lt;ref>')
    expect(html).not.toContain('<ref>')
  })
})

describe('renderFallbackLink', () => {
  it('keeps the ref visible and links to GitHub', () => {
    const html = renderFallbackLink('avride/av#36812', 'https://github.com/avride/av/pull/36812', 'offline')
    expect(html).toContain('avride/av#36812')
    expect(html).toContain('href="https://github.com/avride/av/pull/36812"')
    expect(html).toContain('⚠')
  })
  it('puts the failure message in the tooltip, escaped', () => {
    const html = renderFallbackLink('k', 'https://x.test/1', 'bad <token>')
    expect(html).toContain('&lt;token>')
    expect(html).not.toContain('<token>')
  })
  it('drops the href for a non-https url', () => {
    const html = renderFallbackLink('k', 'javascript:alert(1)', 'nope')
    expect(html).not.toContain('href')
    expect(html).not.toContain('javascript:')
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run src/badge.test.tsx`
Expected: FAIL — `./badge` resolves to the old `.ts` which has no `safeHref` export and a different `escapeHtml` surface.

- [ ] **Step 3: Write `src/badge.tsx`**

The four `d` strings are copied verbatim from the existing `src/badge.ts`; do not retype them.

```tsx
import { render } from 'preact-render-to-string'
import type { CacheEntry } from './cache'
import type { PrState } from './github'

const ICON_PATHS: Record<PrState, string> = {
  open: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
  merged: 'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z',
  closed: 'M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z',
  draft: 'M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z',
}

/**
 * https-only href, returned as props to spread. Preact escapes attribute values
 * but does NOT block dangerous URL schemes, so this guard is still required —
 * removing it reintroduces a vulnerability this project already shipped once.
 * Returning props rather than a string means a bad scheme emits no href at all.
 */
export function safeHref(url: string): { href?: string } {
  return /^https:\/\//i.test(url) ? { href: url } : {}
}

const Icon = ({ state }: { state: PrState }) => (
  <svg
    class="pr-badge__icon"
    viewBox="0 0 16 16"
    width={16}
    height={16}
    aria-hidden="true"
    focusable="false"
  >
    <path d={ICON_PATHS[state]} />
  </svg>
)

const Badge = ({ entry, refKey, stale }: {
  entry: CacheEntry
  refKey: string
  stale: boolean
}) => (
  <a
    class="pr-badge"
    data-state={entry.state}
    {...(stale ? { 'data-stale': 'true' } : {})}
    {...safeHref(entry.url)}
    target="_blank"
    rel="noopener noreferrer"
    title={`${entry.state} · ${refKey}`}
  >
    <Icon state={entry.state} />
    <span class="pr-badge__title">{entry.title}</span>
  </a>
)

const Skeleton = ({ refKey }: { refKey: string }) => (
  <span class="pr-badge pr-badge--skeleton" aria-busy="true" title={`loading ${refKey}`}>
    <span class="pr-badge__title">{refKey}</span>
  </span>
)

const ErrorBadge = ({ message }: { message: string }) => (
  <span class="pr-badge pr-badge--error" title={message}>
    <span class="pr-badge__title">⚠ {message}</span>
  </span>
)

const FallbackLink = ({ refKey, url, message }: {
  refKey: string
  url: string
  message: string
}) => (
  <a
    class="pr-badge pr-badge--error"
    {...safeHref(url)}
    target="_blank"
    rel="noopener noreferrer"
    title={message}
  >
    <span class="pr-badge__title">⚠ {refKey}</span>
  </a>
)

export const renderBadge = (
  entry: CacheEntry, refKey: string, opts: { stale: boolean },
): string => render(<Badge entry={entry} refKey={refKey} stale={opts.stale} />)

export const renderSkeleton = (refKey: string): string =>
  render(<Skeleton refKey={refKey} />)

export const renderError = (message: string): string =>
  render(<ErrorBadge message={message} />)

export const renderFallbackLink = (
  refKey: string, url: string, message: string,
): string => render(<FallbackLink refKey={refKey} url={url} message={message} />)
```

- [ ] **Step 4: Remove the old module and the probe**

```bash
git rm src/badge.ts src/badge.test.ts src/jsx-probe.test.tsx
```

- [ ] **Step 5: Run the full suite, typecheck, build**

```bash
pnpm vitest run src/badge.test.tsx
pnpm test
pnpm typecheck
pnpm build
```
Expected: badge suite green; full suite green; clean typecheck; build succeeds. `index.ts` should need no edit because the four exported signatures are unchanged — if it does need one, stop and report, because that means a signature drifted.

- [ ] **Step 6: Sanity-check the rendered output by eye**

```bash
node -e "
const { renderBadge } = require('./dist/assets/' + require('fs').readdirSync('./dist/assets').find(f=>f.endsWith('.js')));
" 2>/dev/null || echo "skip: bundle is ESM; instead read one rendered string from the test output above"
```
Confirm from the test output that a badge renders as an `<a class="pr-badge" data-state="…">` with an inline `<svg>` and a `<span class="pr-badge__title">`. Attribute order and self-closing style may differ from the old strings; content and structure must not.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: render badges with Preact JSX instead of template strings

Deletes the hand-rolled escapeHtml — Preact escapes children and
attribute values structurally. safeHref survives, now returning props
to spread, because Preact does not block javascript: URLs.

Exported signatures unchanged, so index.ts is untouched."
```

---

## Task 4: `cache.ts` — Schema and KeyValueStore

The code below is not sketched; it was written, typechecked and run against `effect@4.0.0-rc.112` before this plan was finalised.

**Files:**
- Modify: `src/cache.ts` (rewrite), `src/badge.tsx` (one import line), `src/github.ts` (remove `PrState`), `src/index.ts` (import lines)
- Create: `src/cache.test.ts` (replacing the old one)

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `PrStateSchema`, `type PrState = typeof PrStateSchema.Type` — **`PrState` now lives here, not in `github.ts`**
  - `CacheEntrySchema`, `type CacheEntry = typeof CacheEntrySchema.Type`
  - `PREFIX = 'logseq-pr-badges:v1:'`, `DEFAULT_TTL_MS`
  - `isTerminal(s: PrState): boolean`, `isFresh(e: CacheEntry, now: number, ttl?: number): boolean`
  - `interface CacheService { get(key): Effect<Option<CacheEntry>>; set(key, entry): Effect<void> }`
  - `Cache` — the `Context.Service` tag
  - `layer` — `Layer<CacheService, never, KeyValueStore>`

- [ ] **Step 1: Write the failing tests**

Create `src/cache.test.ts`:
```ts
import { describe, expect } from 'vitest'
import { it } from '@effect/vitest'
import { Effect, Layer, Option } from 'effect'
import { KeyValueStore } from 'effect/unstable/persistence'
import { TestClock } from 'effect/testing'
import {
  Cache, layer, PREFIX, isFresh, isTerminal, DEFAULT_TTL_MS, type CacheEntry,
} from './cache'

const testLayer = Layer.provideMerge(layer, KeyValueStore.layerMemory)

const entry = (o: Partial<CacheEntry> = {}): CacheEntry => ({
  state: 'open', title: 'A title', url: 'https://x.test/1', fetchedAt: 1000, ...o,
})

describe('isTerminal', () => {
  it('treats merged and closed as terminal', () => {
    expect(isTerminal('merged')).toBe(true)
    expect(isTerminal('closed')).toBe(true)
  })
  it('treats open and draft as non-terminal', () => {
    expect(isTerminal('open')).toBe(false)
    expect(isTerminal('draft')).toBe(false)
  })
})

describe('Cache', () => {
  it.effect('round-trips an entry', () =>
    Effect.gen(function* () {
      const cache = yield* Cache
      yield* cache.set('avride/av#1', entry())
      expect(Option.getOrNull(yield* cache.get('avride/av#1'))).toEqual(entry())
    }).pipe(Effect.provide(testLayer)))

  it.effect('returns none for a miss', () =>
    Effect.gen(function* () {
      const cache = yield* Cache
      expect(Option.isNone(yield* cache.get('nope/nope#1'))).toBe(true)
    }).pipe(Effect.provide(testLayer)))

  it.effect('reads a corrupt entry as a miss instead of failing', () =>
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore
      yield* kv.set(`${PREFIX}avride/av#1`, '{not json')
      const cache = yield* Cache
      expect(Option.isNone(yield* cache.get('avride/av#1'))).toBe(true)
    }).pipe(Effect.provide(testLayer)))

  it.effect('reads an entry with an unknown state as a miss', () =>
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore
      yield* kv.set(
        `${PREFIX}avride/av#1`,
        JSON.stringify({ ...entry(), state: 'exploded' }),
      )
      const cache = yield* Cache
      expect(Option.isNone(yield* cache.get('avride/av#1'))).toBe(true)
    }).pipe(Effect.provide(testLayer)))

  it.effect('namespaces keys with the schema version', () =>
    Effect.gen(function* () {
      const cache = yield* Cache
      yield* cache.set('avride/av#1', entry())
      const kv = yield* KeyValueStore.KeyValueStore
      expect(Option.isSome(yield* kv.get(`${PREFIX}avride/av#1`))).toBe(true)
    }).pipe(Effect.provide(testLayer)))
})

describe('isFresh', () => {
  it.effect('treats a recent non-terminal entry as fresh, then stale', () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(DEFAULT_TTL_MS - 1)
      const t1 = yield* Effect.clockWith((c) => c.currentTimeMillis)
      expect(isFresh(entry({ fetchedAt: 0 }), t1)).toBe(true)
      yield* TestClock.adjust(2)
      const t2 = yield* Effect.clockWith((c) => c.currentTimeMillis)
      expect(isFresh(entry({ fetchedAt: 0 }), t2)).toBe(false)
    }))

  it.effect('pins terminal states regardless of the clock', () =>
    Effect.gen(function* () {
      yield* TestClock.adjust('365 days')
      const now = yield* Effect.clockWith((c) => c.currentTimeMillis)
      expect(isFresh(entry({ state: 'merged', fetchedAt: 0 }), now)).toBe(true)
      expect(isFresh(entry({ state: 'closed', fetchedAt: 0 }), now)).toBe(true)
    }))

  it('honours a custom ttl', () => {
    expect(isFresh(entry({ fetchedAt: 0 }), 500, 1000)).toBe(true)
    expect(isFresh(entry({ fetchedAt: 0 }), 1500, 1000)).toBe(false)
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run src/cache.test.ts`
Expected: FAIL — `Cache`, `layer`, `isTerminal` are not exported by the current `cache.ts`.

- [ ] **Step 3: Write `src/cache.ts`**

```ts
import { Context, Effect, Layer, Option, Schema } from 'effect'
import { KeyValueStore } from 'effect/unstable/persistence'

export const PrStateSchema = Schema.Literals(['open', 'draft', 'merged', 'closed'])
export type PrState = typeof PrStateSchema.Type

export const CacheEntrySchema = Schema.Struct({
  state: PrStateSchema,
  title: Schema.String,
  url: Schema.String,
  fetchedAt: Schema.Finite,
})
export type CacheEntry = typeof CacheEntrySchema.Type

export const PREFIX = 'logseq-pr-badges:v1:'
export const DEFAULT_TTL_MS = 15 * 60 * 1000

export const isTerminal = (s: PrState): boolean => s === 'merged' || s === 'closed'

export const isFresh = (
  e: CacheEntry, now: number, ttl: number = DEFAULT_TTL_MS,
): boolean => (isTerminal(e.state) ? true : now - e.fetchedAt < ttl)

export interface CacheService {
  readonly get: (key: string) => Effect.Effect<Option.Option<CacheEntry>>
  readonly set: (key: string, entry: CacheEntry) => Effect.Effect<void>
}

export const Cache = Context.Service<CacheService, CacheService>(
  'logseq-pr-badges/Cache',
)

export const layer = Layer.effect(Cache)(
  Effect.gen(function* () {
    const kv = yield* KeyValueStore.KeyValueStore
    const store = KeyValueStore.toSchemaStore(
      KeyValueStore.prefix(kv, PREFIX),
      CacheEntrySchema,
    )
    return {
      // toSchemaStore's get FAILS the Effect on a decode error. A corrupt entry
      // must read as a miss and never propagate.
      get: (key: string) =>
        store.get(key).pipe(Effect.orElseSucceed(() => Option.none<CacheEntry>())),
      // Writes are best-effort, matching the shipped behaviour: a failed write
      // just means one more fetch next render. Never propagate.
      set: (key: string, entry: CacheEntry) => Effect.ignore(store.set(key, entry)),
    } satisfies CacheService
  }),
)
```

- [ ] **Step 4: Move the `PrState` import in the three consumers**

`PrState` now originates here. Update:
- `src/badge.tsx`: change `import type { PrState } from './github'` to `import type { CacheEntry, PrState } from './cache'` and delete the now-duplicate `CacheEntry` import line.
- `src/github.ts`: delete its `export type PrState = ...` declaration and add `import type { PrState } from './cache'`. Its `deriveState` return type is unchanged.
- `src/index.ts`: adjust import lines so `CacheEntry` and `PrState` come from `./cache`.

Do not change any logic in this step — imports only.

- [ ] **Step 5: Run everything**

```bash
pnpm vitest run src/cache.test.ts
pnpm test
pnpm typecheck
```
Expected: cache suite green, full test suite green, and **`pnpm typecheck` FAILING** — but only inside `src/index.ts`.

That failure is expected and correct for this task: `index.ts` still calls the old
synchronous `cache.get`/`put`, and rewiring it is Task 6's job. Record the exact
errors in your report and confirm every one names `src/index.ts`. If a single error
points anywhere else, stop and report — that means an interface drifted.

`pnpm build` will also fail for the same reason; do not attempt to fix it here.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: back the cache with effect Schema and KeyValueStore

PrState is now derived from the schema rather than declared as a union
plus a hand-synced runtime allowlist, removing the as-cast and the DRY
defect that badge.ts's unescaped data-state interpolation relied on.

Reads wrap toSchemaStore's get, which fails rather than returning None
on a decode error; writes are ignored, preserving best-effort semantics.

index.ts does not typecheck until Task 6 rewires it."
```

---

## Task 5: `github.ts` — tagged errors, resolver, Schedule

**Files:**
- Modify: `src/github.ts` (rewrite)
- Create: `src/github.test.ts` (replacing the old one)

**Interfaces:**
- Consumes: `PrRef`, `refKey` from `./ref`; `PrState` from `./cache`
- Produces:
  - `class NotFound extends Data.TaggedError('NotFound')<{ key: string }>`
  - `class AuthFailed extends Data.TaggedError('AuthFailed')<{ status: number }>`
  - `class RateLimited extends Data.TaggedError('RateLimited')<{ retryAfterMs: number }>`
  - `class NetworkFailed extends Data.TaggedError('NetworkFailed')<{ message: string }>`
  - `class QueryFailed extends Data.TaggedError('QueryFailed')<{ message: string }>`
  - `type PrError = NotFound | AuthFailed | RateLimited | NetworkFailed | QueryFailed`
  - `interface PrData { state: PrState; title: string; url: string }`
  - `buildQuery(refs: PrRef[]): string` — unchanged behaviour
  - `deriveState(state: string, isDraft: boolean): PrState` — unchanged behaviour
  - `class GetPr extends Request.TaggedClass('GetPr')<{ ref: PrRef }, PrData, PrError>`
  - `makeResolver(token: string, fetchImpl?: typeof fetch): RequestResolver<GetPr>`
  - `retryPolicy` — a `Schedule` retrying only `RateLimited` and `NetworkFailed`

- [ ] **Step 1: Write the failing tests**

Create `src/github.test.ts`. The batch-count assertion is the important one — it is the only thing that catches Verified mechanics #3.

```ts
import { describe, expect } from 'vitest'
import { it } from '@effect/vitest'
import { Effect, Exit, Fiber, Schedule } from 'effect'
import { TestClock } from 'effect/testing'
import {
  buildQuery, deriveState, makeResolver, GetPr, retryPolicy,
  NotFound, AuthFailed, RateLimited, QueryFailed,
} from './github'
import type { PrRef } from './ref'

const REF_A: PrRef = { owner: 'avride', repo: 'av', number: 36812 }
const REF_B: PrRef = { owner: 'avride', repo: 'rootfs', number: 1780 }

const jsonResponse = (body: unknown, status = 200): Response => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
} as unknown as Response)

const prNode = (over: Record<string, unknown> = {}) => ({
  title: 'EMB-2887: Bringup', url: 'https://github.com/avride/av/pull/36812',
  state: 'OPEN', isDraft: true, ...over,
})

describe('deriveState', () => {
  it('maps MERGED to merged', () => expect(deriveState('MERGED', false)).toBe('merged'))
  it('maps CLOSED to closed', () => expect(deriveState('CLOSED', false)).toBe('closed'))
  it('maps OPEN + isDraft to draft', () => expect(deriveState('OPEN', true)).toBe('draft'))
  it('maps OPEN to open', () => expect(deriveState('OPEN', false)).toBe('open'))
  it('ignores isDraft once merged', () => expect(deriveState('MERGED', true)).toBe('merged'))
})

describe('buildQuery', () => {
  it('gives each ref a distinct alias', () => {
    const q = buildQuery([REF_A, REF_B])
    expect(q).toContain('a0: repository')
    expect(q).toContain('a1: repository')
    expect(q).toContain('pullRequest(number: 36812)')
    expect(q).toContain('pullRequest(number: 1780)')
  })
  it('quotes owner and repo as JSON strings', () => {
    expect(buildQuery([REF_A])).toContain('owner: "avride", name: "av"')
  })
})

describe('the resolver', () => {
  it.effect('issues ONE request for a concurrent batch', () =>
    Effect.gen(function* () {
      let calls = 0
      const fetchImpl = (async () => {
        calls += 1
        return jsonResponse({ data: { a0: { pullRequest: prNode() }, a1: { pullRequest: prNode() } } })
      }) as unknown as typeof fetch
      const resolver = makeResolver('tok', fetchImpl)
      const out = yield* Effect.forEach(
        [REF_A, REF_B],
        (ref) => Effect.request(new GetPr({ ref }), resolver),
        { batching: true, concurrency: 'unbounded' },
      )
      expect(out.length).toBe(2)
      // Without concurrency: 'unbounded' this would be 2. See Verified mechanics #3.
      expect(calls).toBe(1)
    }))

  it.effect('fails a missing ref with NotFound', () =>
    Effect.gen(function* () {
      const fetchImpl = (async () => jsonResponse({ data: { a0: null } })) as unknown as typeof fetch
      const resolver = makeResolver('tok', fetchImpl)
      const r = yield* Effect.exit(Effect.request(new GetPr({ ref: REF_A }), resolver))
      expect(Exit.isFailure(r)).toBe(true)
    }))

  it.effect('classifies 401 as AuthFailed', () =>
    Effect.gen(function* () {
      const fetchImpl = (async () => jsonResponse({}, 401)) as unknown as typeof fetch
      const resolver = makeResolver('bad', fetchImpl)
      const msg = yield* Effect.request(new GetPr({ ref: REF_A }), resolver).pipe(
        Effect.map(() => 'ok'),
        Effect.catchTag('AuthFailed', (e: AuthFailed) => Effect.succeed(`auth ${e.status}`)),
        Effect.catchAll(() => Effect.succeed('other')),
      )
      expect(msg).toBe('auth 401')
    }))

  it.effect('classifies a top-level errors response as QueryFailed, not NotFound', () =>
    Effect.gen(function* () {
      const fetchImpl = (async () => jsonResponse({
        errors: [{ message: 'Query has complexity of 1000000, which exceeds max' }],
      })) as unknown as typeof fetch
      const resolver = makeResolver('tok', fetchImpl)
      const msg = yield* Effect.request(new GetPr({ ref: REF_A }), resolver).pipe(
        Effect.map(() => 'ok'),
        Effect.catchTag('QueryFailed', (e: QueryFailed) => Effect.succeed(e.message)),
        Effect.catchAll(() => Effect.succeed('other')),
      )
      expect(msg).toContain('complexity')
    }))

  it.effect('reads the retry delay from x-ratelimit-reset', () =>
    Effect.gen(function* () {
      const resetSec = Math.floor(Date.now() / 1000) + 300
      const fetchImpl = (async () => ({
        ok: false, status: 403,
        headers: { get: (h: string) => (h === 'x-ratelimit-reset' ? String(resetSec) : null) },
        json: async () => ({}),
      } as unknown as Response)) as unknown as typeof fetch
      const resolver = makeResolver('tok', fetchImpl)
      const ms = yield* Effect.request(new GetPr({ ref: REF_A }), resolver).pipe(
        Effect.map(() => -1),
        Effect.catchTag('RateLimited', (e: RateLimited) => Effect.succeed(e.retryAfterMs)),
        Effect.catchAll(() => Effect.succeed(-2)),
      )
      expect(ms).toBeGreaterThan(250_000)
      expect(ms).toBeLessThanOrEqual(300_000)
    }))

  it.effect('never puts the token in an error message', () =>
    Effect.gen(function* () {
      const fetchImpl = (async () => { throw new Error('boom') }) as unknown as typeof fetch
      const resolver = makeResolver('super-secret-token', fetchImpl)
      const msg = yield* Effect.request(new GetPr({ ref: REF_A }), resolver).pipe(
        Effect.map(() => ''),
        Effect.catchAll((e) => Effect.succeed(JSON.stringify(e))),
      )
      expect(msg).not.toContain('super-secret-token')
    }))
})

describe('retryPolicy', () => {
  it.effect('retries a RateLimited failure under TestClock', () =>
    Effect.gen(function* () {
      let attempts = 0
      const flaky = Effect.suspend(() => {
        attempts += 1
        return attempts < 3
          ? Effect.fail(new RateLimited({ retryAfterMs: 1000 }))
          : Effect.succeed('recovered')
      })
      // A time-based Schedule never elapses on its own under TestClock, so the
      // retry is forked and the clock advanced. See Verified mechanics #7.
      const fiber = yield* Effect.forkChild(
        Effect.retry(flaky, { schedule: retryPolicy, times: 5 }),
      )
      yield* TestClock.adjust('1 minute')
      expect(yield* Fiber.join(fiber)).toBe('recovered')
      expect(attempts).toBe(3)
    }))

  it.effect('does not retry a NotFound failure', () =>
    Effect.gen(function* () {
      let attempts = 0
      const always = Effect.suspend(() => {
        attempts += 1
        return Effect.fail(new NotFound({ key: 'avride/av#1' }))
      })
      const fiber = yield* Effect.forkChild(
        Effect.exit(Effect.retry(always, { schedule: retryPolicy, times: 5 })),
      )
      yield* TestClock.adjust('1 minute')
      yield* Fiber.join(fiber)
      expect(attempts).toBe(1)
    }))
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run src/github.test.ts`
Expected: FAIL — `makeResolver`, `GetPr`, `retryPolicy` and the error classes are not exported yet.

- [ ] **Step 3: Write `src/github.ts`**

```ts
import { Data, Effect, Exit, Request, RequestResolver, Schedule } from 'effect'
import type { PrRef } from './ref'
import { refKey } from './ref'
import type { PrState } from './cache'

export class NotFound extends Data.TaggedError('NotFound')<{ key: string }> {}
export class AuthFailed extends Data.TaggedError('AuthFailed')<{ status: number }> {}
export class RateLimited extends Data.TaggedError('RateLimited')<{ retryAfterMs: number }> {}
export class NetworkFailed extends Data.TaggedError('NetworkFailed')<{ message: string }> {}
export class QueryFailed extends Data.TaggedError('QueryFailed')<{ message: string }> {}

export type PrError = NotFound | AuthFailed | RateLimited | NetworkFailed | QueryFailed

export interface PrData {
  readonly state: PrState
  readonly title: string
  readonly url: string
}

const ENDPOINT = 'https://api.github.com/graphql'
const BATCH_MAX = 25

export const deriveState = (state: string, isDraft: boolean): PrState => {
  if (state === 'MERGED') return 'merged'
  if (state === 'CLOSED') return 'closed'
  return isDraft ? 'draft' : 'open'
}

export const buildQuery = (refs: readonly PrRef[]): string => {
  const parts = refs.map((r, i) =>
    `a${i}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.repo)}) ` +
    `{ pullRequest(number: ${r.number}) { title url state isDraft } }`,
  )
  return `query { ${parts.join(' ')} }`
}

/** Retry delay after a rate limit. Headers are absent in tests, hence the
 *  optional chaining and the one-minute floor. */
const retryAfterMsFrom = (res: Response): number => {
  const retryAfter = Number(res.headers?.get?.('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000
  const reset = Number(res.headers?.get?.('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset > 0) {
    const delta = reset * 1000 - Date.now()
    if (delta > 0) return delta
  }
  return 60_000
}

export class GetPr extends Request.TaggedClass('GetPr')<
  { readonly ref: PrRef },
  PrData,
  PrError
> {}

/** Retries only the transient failures. NotFound, AuthFailed and QueryFailed are
 *  terminal: retrying them cannot help and would hammer the API. */
export const retryPolicy = Schedule.exponential('1 second').pipe(
  Schedule.jittered,
  Schedule.while(({ input }: { input: PrError }) =>
    input._tag === 'RateLimited' || input._tag === 'NetworkFailed'),
)

export const makeResolver = (
  token: string,
  fetchImpl: typeof fetch = fetch,
): RequestResolver.RequestResolver<GetPr> =>
  RequestResolver.make<GetPr>((entries) =>
    Effect.gen(function* () {
      const refs = entries.map((e) => e.request.ref)

      const failAll = (e: PrError) => {
        for (const entry of entries) entry.completeUnsafe(Exit.fail(e))
      }

      let res: Response
      try {
        res = yield* Effect.promise(() =>
          fetchImpl(ENDPOINT, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query: buildQuery(refs) }),
          }),
        )
      } catch (e) {
        failAll(new NetworkFailed({ message: (e as Error).message || 'network request failed' }))
        return
      }

      if (res.status === 401) {
        failAll(new AuthFailed({ status: 401 }))
        return
      }
      if (res.status === 403 || res.status === 429) {
        failAll(new RateLimited({ retryAfterMs: retryAfterMsFrom(res) }))
        return
      }
      if (!res.ok) {
        failAll(new QueryFailed({ message: `GitHub returned HTTP ${res.status}.` }))
        return
      }

      let body: any
      try {
        body = yield* Effect.promise(() => res.json())
      } catch {
        failAll(new QueryFailed({ message: 'GitHub returned a malformed response body.' }))
        return
      }

      // A response carrying only top-level `errors` has no `data` at all. Without
      // this, every ref would be reported NotFound, misdirecting the user to
      // their token when the fault is the query.
      if (body?.data == null && Array.isArray(body?.errors) && body.errors.length > 0) {
        const first = String(body.errors[0]?.message ?? 'GitHub returned an error')
        failAll(new QueryFailed({ message: `GitHub returned an error: ${first}` }))
        return
      }

      entries.forEach((entry, i) => {
        const node = body?.data?.[`a${i}`]?.pullRequest
        if (!node) {
          entry.completeUnsafe(Exit.fail(new NotFound({ key: refKey(entry.request.ref) })))
          return
        }
        entry.completeUnsafe(Exit.succeed({
          state: deriveState(String(node.state), Boolean(node.isDraft)),
          title: String(node.title ?? ''),
          url: String(node.url ?? ''),
        }))
      })
    }),
  ).pipe(RequestResolver.batchN(BATCH_MAX))
```

- [ ] **Step 4: Run and iterate**

Run: `pnpm vitest run src/github.test.ts`
Expected: PASS, 16 tests.

Two likely snags, both with known fixes:
- If `Schedule.while` rejects the predicate's shape, the v4 combinator may take the input directly rather than a `{ input }` record. Check `node_modules/effect/dist/Schedule.d.ts` for `while`'s signature and adapt the predicate. Do not switch to retrying everything.
- If `Effect.promise` rejects rather than throwing into the `try`, replace the `try/catch` with `Effect.tryPromise` and map the failure into `NetworkFailed`.

- [ ] **Step 5: Full suite and typecheck**

```bash
pnpm test
pnpm typecheck
```
Expected: all suites except `index.ts`'s typecheck green. As in Task 4, `index.ts` errors are expected until Task 6 — confirm they are confined to `src/index.ts`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: model GitHub fetching with tagged errors and a resolver

FetchOutcome's kind-string union becomes Data.TaggedError classes, so
catchTag replaces the if-chains and the compiler enforces exhaustiveness.
QueryFailed now distinguishes a bad query from a missing PR by type.

Batching goes through RequestResolver.batchN; note callers MUST pass
concurrency alongside batching: true or every ref becomes its own
request. Retry uses a jittered exponential Schedule limited to the
transient failures."
```

---

## Task 6: `index.ts` — ManagedRuntime and Refs

The last task, and the only one with no unit tests — it talks to the plugin host. Its correctness gate is review plus the manual GUI checklist.

**Files:**
- Modify: `src/index.ts` (rewrite)

**Interfaces:**
- Consumes: everything from Tasks 3-5
- Produces: nothing importable — this is the entry point

Preserve these behaviours exactly; each one was a bug fixed under review last session and each is easy to lose in a rewrite:

1. `flush` wraps its body in `try/finally` so the overflow re-schedule cannot be skipped by an early return.
2. The flush timer callback attaches a `.catch`.
3. The rate-limit gate re-queues its batch, and `scheduleFlush`'s delay is `Math.max(BATCH_DEBOUNCE_MS, rateLimitedUntil - Date.now())`.
4. The refresh command does **not** clear the cache; it re-queues live keys and lets successful fetches overwrite.
5. `onSettingsChanged` re-queues everything on screen, so pasting a token takes effect immediately.
6. A cold-cache failure renders `renderFallbackLink` with the PR URL, not a bare error.
7. The stylesheet keeps both inline rules: `div.macro:has(.pr-badge) { display: inline; }` and `div.macro:has(.pr-badge) > * { display: inline; }`.
8. Every render path outputs something. No silent blank.

- [ ] **Step 1: Build the runtime and layers**

At the top of `main()`, replace nothing yet — first add the runtime construction:

```ts
import { Effect, Layer, ManagedRuntime, Option, Ref } from 'effect'
import { KeyValueStore } from 'effect/unstable/persistence'
import { Cache, layer as cacheLayer, isFresh, DEFAULT_TTL_MS } from './cache'
import type { CacheEntry } from './cache'

const appLayer = Layer.provideMerge(cacheLayer, KeyValueStore.layerStorage(() => localStorage))
const runtime = ManagedRuntime.make(appLayer)
```

`layerStorage` takes a thunk returning a `Storage`, not the storage itself.

- [ ] **Step 2: Convert the module-level state to Refs**

Replace the four mutable bindings. `liveSlots`, `pending` and `notFound` become `Ref`s holding the same `Map`s; `rateLimitedUntil` becomes a `Ref<number>`:

```ts
const liveSlotsRef = Effect.runSync(Ref.make(new Map<string, { slot: string; key: string }>()))
const pendingRef = Effect.runSync(Ref.make(new Map<string, PrRef>()))
const notFoundRef = Effect.runSync(Ref.make(new Map<string, number>()))
const rateLimitedUntilRef = Effect.runSync(Ref.make(0))
let flushTimer: ReturnType<typeof setTimeout> | null = null
```

`flushTimer` stays a plain binding — it holds a host timer handle, not application state.

- [ ] **Step 3: Rewrite the cache reads and writes at the call sites**

`handleMacro` reads the cache synchronously so a cache hit paints without a skeleton flash. That property is required, so use `runSync`:

```ts
const cached = runtime.runSync(
  Effect.gen(function* () {
    const cache = yield* Cache
    return yield* cache.get(key)
  }),
)
if (Option.isSome(cached)) {
  drawFromCache(slot, key, cached.value)
  if (isFresh(cached.value, Date.now(), ttlMs())) return
}
```

In `flush`, replace `put(key, entry)` with a `runPromise`d `cache.set`. The resolver
is built per flush from the current token, because the token can change at runtime via
`onSettingsChanged` and a resolver captures it:

```ts
import { makeResolver, GetPr } from './github'

// inside flush(), after the empty-token guard:
const resolver = makeResolver(tok)
```

Then the batched fetch becomes:

```ts
const results = await runtime.runPromise(
  Effect.forEach(
    batch.map(([, ref]) => ref),
    (ref) => Effect.either(Effect.request(new GetPr({ ref }), resolver)),
    { batching: true, concurrency: 'unbounded' },
  ),
)
```

`concurrency: 'unbounded'` is required for batching (Verified mechanics #3). `Effect.either` keeps one ref's failure from cancelling the rest of the batch.

- [ ] **Step 4: Map tagged errors onto the render paths**

Replace the `outcome.kind === ...` chain with tag matching, preserving the same visible outcomes:

```ts
// NotFound      -> notFound.set(key, now) + renderError(message naming both causes)
// RateLimited   -> set rateLimitedUntilRef; then cached-dimmed or fallback link
// AuthFailed    -> cached-dimmed, else fallback link
// NetworkFailed -> cached-dimmed, else fallback link
// QueryFailed   -> cached-dimmed, else fallback link
```

Use `error._tag` in a `switch` with an exhaustive `default` that renders the fallback link — never a silent blank.

- [ ] **Step 5: Add the settings hook and the refresh command**

Keep `requeueAllLive` and both call sites (command palette and `onSettingsChanged`), with the comment explaining why the cache is deliberately not cleared.

- [ ] **Step 6: Typecheck, test, build**

```bash
pnpm typecheck
pnpm test
pnpm build
ls -l dist/index.html
```
Expected: clean typecheck for the first time since Task 3; full suite green; `dist/index.html` produced. Record the bundle size — the spec projects roughly 58 kB gzip.

- [ ] **Step 7: Re-read the eight preserved behaviours above against your code**

Go through the numbered list one at a time and point at the line implementing each. Any you cannot find is a regression — fix it before committing. Write the eight line references into your report.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: run the plugin on a ManagedRuntime with Ref state

Layers are built once at init; callbacks run Effects at the boundary,
with runSync on the cache-hit path so a warm cache still paints without
a skeleton flash. The reviewed control flow is unchanged: same flush
try/finally, same rate-limit re-queue, same non-clearing refresh, same
fallback link on a cold-cache failure."
```

---

## After the plan

`pnpm build` output must be loaded into Logseq and walked against
`docs/PHASE-1-MANUAL-VERIFICATION.md` before this branch merges. The unit suite
cannot see the two things most likely to break: whether badges still render inline,
and whether the Preact-rendered markup still satisfies Logseq's slot injection.
