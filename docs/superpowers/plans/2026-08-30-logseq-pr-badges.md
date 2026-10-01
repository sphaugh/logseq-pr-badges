# logseq-pr-badges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Logseq plugin that renders `{{pr owner/repo#number}}` as a GitHub-style
colored state octicon followed by the PR title, linking to the PR.

**Architecture:** A `:macros` entry in `config.edn` expands `{{pr X}}` to
`{{renderer :pr, X}}`, which Logseq re-parses and dispatches to the plugin's
`onMacroRendererSlotted` hook. Four pure modules (parse, fetch, cache, render) do all
the work and are unit-tested without a Logseq instance; a single wiring module talks
to the plugin host. State and title are cached in `localStorage` with merged/closed
pinned forever, so a settled graph makes almost no network requests.

**Tech Stack:** TypeScript, Vite, Vitest, pnpm, `@logseq/libs` 0.0.17, GitHub GraphQL v4.

**Spec:** `docs/superpowers/specs/2026-08-29-logseq-pr-badges-design.md`

## Global Constraints

- Macro syntax is exactly `{{pr owner/repo#number}}`. No default repo, no bare
  numbers, no URL form. Anything else renders a visible inline error.
- The plugin **never writes to a Logseq block**. There is no hydration.
- PR titles live only in `localStorage`, never in the markdown.
- Terminal states (`merged`, `closed`) are cached forever and never refetched.
  Non-terminal states (`open`, `draft`) expire on a TTL, default 15 minutes.
- Every render path produces visible output. Never a blank, never an error box.
- All fetched text is HTML-escaped before insertion — PR titles are free text.
- `localStorage` access is always wrapped in try/catch; it throws outright in some
  contexts and a corrupt entry must read as a cache miss.
- Cache keys are prefixed `logseq-pr-badges:v1:` — bump `v1` to invalidate on a
  schema change.
- Module import direction is `ref → github → cache → badge → index`. No cycles.
  `PrState` and `PrData` originate in `github.ts`; `CacheEntry` in `cache.ts`.

### Resolved constants

Primer functional colors, read from `@primer/primitives` built CSS on 2026-08-30
(`dist/css/functional/themes/{light,dark}.css`). Two of these differ from
commonly-cited values — use exactly these:

| State | Primer token | Light | Dark |
|---|---|---|---|
| `open` | `fgColor-open` → `fgColor-success` | `#1a7f37` | `#3fb950` |
| `merged` | `fgColor-done` | `#8250df` | `#ab7df8` |
| `closed` | `fgColor-closed` → `fgColor-danger` | `#d1242f` | `#f85149` |
| `draft` | `fgColor-muted` | `#59636e` | `#9198a1` |

Octicon path data (16px, MIT licensed, fetched from `primer/octicons`) is given
verbatim in Task 5.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | pnpm manifest **and** Logseq plugin manifest (`logseq` key) |
| `vite.config.ts` | Build to `dist/`, plus Vitest config |
| `tsconfig.json` | Strict TypeScript |
| `index.html` | Plugin entry document; loads `src/index.ts` |
| `icon.svg` | Plugin icon |
| `src/ref.ts` | Parse a macro argument into a `PrRef`; canonical cache keys |
| `src/github.ts` | Batched GraphQL fetch; state derivation; typed failures |
| `src/cache.ts` | `localStorage` store; TTL and terminal pinning |
| `src/badge.ts` | Cache entry → escaped HTML (octicon + title + link) |
| `src/index.ts` | Wiring: settings, renderer hook, batch queue, styles, command |
| `src/*.test.ts` | Vitest, colocated with each pure module |
| `README.md` | Install, `config.edn` setup, token scope |

---

## Task 1: Scaffold, preflight, and a green test run

The token check comes first because a scope failure surfaces later as an
indistinguishable `NOT_FOUND`, which is expensive to debug. If step 1 fails, stop
and report — the whole project is blocked until the token is fixed.

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`,
  `icon.svg`, `.gitignore` (already exists), `src/smoke.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a repo where `pnpm build` emits `dist/index.html` and `pnpm test` passes

- [ ] **Step 1: Verify the GitHub token has `repo` scope**

Run:
```bash
gh api graphql -f query='{repository(owner:"avride",name:"av"){pullRequest(number:36812){number title state isDraft}}}'
```
Expected: JSON containing `"number":36812` and a `state` field.
If this returns `NOT_FOUND` or a permissions error, **stop and report** — the
plugin cannot work until the token can read `avride/av`.

- [ ] **Step 2: Confirm Logseq's plugin system is enabled**

In Logseq: `⋯` menu → Settings → Advanced → enable **Developer mode** and
**Plug-in system**, then restart Logseq. The `{{renderer}}` macro branch is gated on
`config/lsp-enabled?`, so with plugins off nothing renders at all.

- [ ] **Step 3: Write `package.json`**

```json
{
  "name": "logseq-pr-badges",
  "version": "0.1.0",
  "description": "GitHub pull request state badges for Logseq",
  "author": "Sean Haugh",
  "license": "MIT",
  "main": "dist/index.html",
  "scripts": {
    "dev": "vite build --watch",
    "build": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@logseq/libs": "0.0.17"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  },
  "logseq": {
    "id": "logseq-pr-badges",
    "title": "PR Badges",
    "main": "dist/index.html",
    "icon": "./icon.svg"
  }
}
```

- [ ] **Step 4: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext", "DOM"],
    "strict": true,
    "noUnusedLocals": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["vitest/globals"]
  },
  "include": ["src", "vite.config.ts"]
}
```

- [ ] **Step 5: Write `vite.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  base: './',
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

- [ ] **Step 6: Write `index.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>logseq-pr-badges</title>
  </head>
  <body>
    <script type="module" src="/src/index.ts"></script>
  </body>
</html>
```

- [ ] **Step 7: Write `icon.svg`**

The `git-merge` octicon in Primer's merged purple.

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 16 16" fill="#8250df"><path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z"/></svg>
```

- [ ] **Step 8: Write a smoke test so the harness is proven before real tests**

Create `src/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest'

describe('test harness', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 9: Install and verify build + test**

```bash
cd ~/devel/logseq-pr-badges
pnpm install
pnpm test
pnpm build
ls dist/index.html
```
Expected: test passes; `dist/index.html` exists.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: scaffold vite + vitest + logseq plugin manifest"
```

---

## Task 2: `ref.ts` — strict reference parsing

**Files:**
- Create: `src/ref.ts`
- Test: `src/ref.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface PrRef { owner: string; repo: string; number: number }`
  - `type ParseResult = { ok: true; ref: PrRef } | { ok: false; reason: string }`
  - `parseRef(raw: string): ParseResult`
  - `refKey(ref: PrRef): string` — returns `"owner/repo#number"`

- [ ] **Step 1: Write the failing tests**

Create `src/ref.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parseRef, refKey } from './ref'

describe('parseRef', () => {
  it('accepts owner/repo#number', () => {
    expect(parseRef('avride/av#36812')).toEqual({
      ok: true,
      ref: { owner: 'avride', repo: 'av', number: 36812 },
    })
  })

  it('trims surrounding whitespace', () => {
    expect(parseRef('  avride/av#36812  ')).toEqual({
      ok: true,
      ref: { owner: 'avride', repo: 'av', number: 36812 },
    })
  })

  it('accepts dots, dashes and underscores in names', () => {
    expect(parseRef('some_owner/rootfs-setup.js#1780')).toEqual({
      ok: true,
      ref: { owner: 'some_owner', repo: 'rootfs-setup.js', number: 1780 },
    })
  })

  it('rejects a bare number', () => {
    expect(parseRef('36812').ok).toBe(false)
  })

  it('rejects a pull request URL', () => {
    expect(parseRef('https://github.com/avride/av/pull/36812').ok).toBe(false)
  })

  it('rejects a missing owner', () => {
    expect(parseRef('av#36812').ok).toBe(false)
  })

  it('rejects a missing number', () => {
    expect(parseRef('avride/av').ok).toBe(false)
  })

  it('rejects a non-numeric number', () => {
    expect(parseRef('avride/av#abc').ok).toBe(false)
  })

  it('rejects zero', () => {
    expect(parseRef('avride/av#0').ok).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(parseRef('').ok).toBe(false)
  })

  it('explains what it expected when it rejects', () => {
    const result = parseRef('36812')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('owner/repo#number')
  })
})

describe('refKey', () => {
  it('renders the canonical form', () => {
    expect(refKey({ owner: 'avride', repo: 'av', number: 36812 })).toBe('avride/av#36812')
  })

  it('normalizes leading zeros so the cache key is stable', () => {
    const parsed = parseRef('avride/av#007')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(refKey(parsed.ref)).toBe('avride/av#7')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/ref.test.ts`
Expected: FAIL — cannot resolve `./ref`.

- [ ] **Step 3: Write the implementation**

Create `src/ref.ts`:
```ts
export interface PrRef {
  owner: string
  repo: string
  number: number
}

export type ParseResult =
  | { ok: true; ref: PrRef }
  | { ok: false; reason: string }

const REF_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)#(\d+)$/

export function parseRef(raw: string): ParseResult {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return { ok: false, reason: 'empty reference; expected owner/repo#number' }
  }

  const m = REF_RE.exec(trimmed)
  if (!m) {
    return { ok: false, reason: `expected owner/repo#number, got "${trimmed}"` }
  }

  const number = Number(m[3])
  if (!Number.isSafeInteger(number) || number <= 0) {
    return { ok: false, reason: `PR number must be a positive integer, got "${m[3]}"` }
  }

  return { ok: true, ref: { owner: m[1]!, repo: m[2]!, number } }
}

export function refKey(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/ref.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ref.ts src/ref.test.ts
git commit -m "feat: parse owner/repo#number pull request references"
```

---

## Task 3: `github.ts` — batched GraphQL fetch

**Files:**
- Create: `src/github.ts`
- Test: `src/github.test.ts`

**Interfaces:**
- Consumes: `PrRef`, `refKey` from `./ref`
- Produces:
  - `type PrState = 'open' | 'draft' | 'merged' | 'closed'`
  - `interface PrData { state: PrState; title: string; url: string }`
  - `type FetchErrorKind = 'not_found' | 'auth' | 'rate_limit' | 'network' | 'unknown'`
  - `type FetchOutcome = { ok: true; data: PrData } | { ok: false; kind: FetchErrorKind; message: string; retryAfterMs?: number }`
  - On `rate_limit`, `retryAfterMs` is read from `retry-after` or `x-ratelimit-reset`, defaulting to 60000.
  - `buildQuery(refs: PrRef[]): string`
  - `deriveState(state: string, isDraft: boolean): PrState`
  - `fetchPrs(refs, token, fetchImpl?): Promise<Map<string, FetchOutcome>>` — keyed by `refKey`

- [ ] **Step 1: Write the failing tests**

Create `src/github.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { buildQuery, deriveState, fetchPrs } from './github'
import type { PrRef } from './ref'

const REF_A: PrRef = { owner: 'avride', repo: 'av', number: 36812 }
const REF_B: PrRef = { owner: 'avride', repo: 'rootfs', number: 1780 }

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

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

describe('fetchPrs', () => {
  it('returns no entries and makes no request for an empty list', async () => {
    const fetchImpl = vi.fn()
    const out = await fetchPrs([], 'token', fetchImpl as unknown as typeof fetch)
    expect(out.size).toBe(0)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('maps a successful response by ref key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      data: { a0: { pullRequest: {
        title: 'EMB-2887: Bringup', url: 'https://github.com/avride/av/pull/36812',
        state: 'OPEN', isDraft: true,
      } } },
    }))
    const out = await fetchPrs([REF_A], 'token', fetchImpl as unknown as typeof fetch)
    expect(out.get('avride/av#36812')).toEqual({
      ok: true,
      data: { state: 'draft', title: 'EMB-2887: Bringup', url: 'https://github.com/avride/av/pull/36812' },
    })
  })

  it('handles a partial result where one ref is missing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      data: {
        a0: { pullRequest: { title: 'ok', url: 'u', state: 'MERGED', isDraft: false } },
        a1: null,
      },
    }))
    const out = await fetchPrs([REF_A, REF_B], 'token', fetchImpl as unknown as typeof fetch)
    expect(out.get('avride/av#36812')!.ok).toBe(true)
    const missing = out.get('avride/rootfs#1780')!
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.kind).toBe('not_found')
  })

  it('says a missing ref may be an access problem, not just a bad number', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { a0: null } }))
    const out = await fetchPrs([REF_A], 'token', fetchImpl as unknown as typeof fetch)
    const outcome = out.get('avride/av#36812')!
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain('access')
  })

  it('classifies 401 as auth', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 401))
    const out = await fetchPrs([REF_A], 'bad', fetchImpl as unknown as typeof fetch)
    const outcome = out.get('avride/av#36812')!
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.kind).toBe('auth')
  })

  it('classifies 403 as rate_limit', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 403))
    const out = await fetchPrs([REF_A], 'token', fetchImpl as unknown as typeof fetch)
    const outcome = out.get('avride/av#36812')!
    if (!outcome.ok) expect(outcome.kind).toBe('rate_limit')
    else throw new Error('expected failure')
  })

  it('classifies a thrown fetch as network', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'))
    const out = await fetchPrs([REF_A], 'token', fetchImpl as unknown as typeof fetch)
    const outcome = out.get('avride/av#36812')!
    if (!outcome.ok) expect(outcome.kind).toBe('network')
    else throw new Error('expected failure')
  })

  it('classifies a malformed body as unknown', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => { throw new Error('bad json') },
    } as unknown as Response)
    const out = await fetchPrs([REF_A], 'token', fetchImpl as unknown as typeof fetch)
    const outcome = out.get('avride/av#36812')!
    if (!outcome.ok) expect(outcome.kind).toBe('unknown')
    else throw new Error('expected failure')
  })

  it('reports how long to wait when rate limited', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: (h: string) => (h === 'retry-after' ? '120' : null) },
      json: async () => ({}),
    } as unknown as Response)
    const out = await fetchPrs([REF_A], 'token', fetchImpl as unknown as typeof fetch)
    const outcome = out.get('avride/av#36812')!
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.kind).toBe('rate_limit')
      expect(outcome.retryAfterMs).toBe(120_000)
    }
  })

  it('sends the token as a bearer credential', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { a0: null } }))
    await fetchPrs([REF_A], 'secret-token', fetchImpl as unknown as typeof fetch)
    const init = fetchImpl.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer secret-token')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/github.test.ts`
Expected: FAIL — cannot resolve `./github`.

- [ ] **Step 3: Write the implementation**

Create `src/github.ts`:
```ts
import type { PrRef } from './ref'
import { refKey } from './ref'

export type PrState = 'open' | 'draft' | 'merged' | 'closed'

export interface PrData {
  state: PrState
  title: string
  url: string
}

export type FetchErrorKind =
  | 'not_found' | 'auth' | 'rate_limit' | 'network' | 'unknown'

export type FetchOutcome =
  | { ok: true; data: PrData }
  | { ok: false; kind: FetchErrorKind; message: string; retryAfterMs?: number }

const ENDPOINT = 'https://api.github.com/graphql'

export function deriveState(state: string, isDraft: boolean): PrState {
  if (state === 'MERGED') return 'merged'
  if (state === 'CLOSED') return 'closed'
  return isDraft ? 'draft' : 'open'
}

export function buildQuery(refs: PrRef[]): string {
  const parts = refs.map((r, i) =>
    `a${i}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.repo)}) ` +
    `{ pullRequest(number: ${r.number}) { title url state isDraft } }`,
  )
  return `query { ${parts.join(' ')} }`
}

function failAll(
  refs: PrRef[], kind: FetchErrorKind, message: string, retryAfterMs?: number,
): Map<string, FetchOutcome> {
  const out = new Map<string, FetchOutcome>()
  for (const r of refs) out.set(refKey(r), { ok: false, kind, message, retryAfterMs })
  return out
}

/** How long to wait after a rate limit. Headers are absent in tests, hence the
 *  optional chaining and the one-minute floor. */
function retryAfterMsFrom(res: Response): number {
  const retryAfter = Number(res.headers?.get?.('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000
  const reset = Number(res.headers?.get?.('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset > 0) {
    const delta = reset * 1000 - Date.now()
    if (delta > 0) return delta
  }
  return 60_000
}

export async function fetchPrs(
  refs: PrRef[],
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, FetchOutcome>> {
  const out = new Map<string, FetchOutcome>()
  if (refs.length === 0) return out

  let res: Response
  try {
    res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: buildQuery(refs) }),
    })
  } catch (e) {
    return failAll(refs, 'network', (e as Error).message || 'network request failed')
  }

  if (res.status === 401) {
    return failAll(refs, 'auth', 'GitHub rejected the token (401). Check the token in plugin settings.')
  }
  if (res.status === 403 || res.status === 429) {
    return failAll(
      refs, 'rate_limit',
      `GitHub rate limited the request (${res.status}).`,
      retryAfterMsFrom(res),
    )
  }
  if (!res.ok) {
    return failAll(refs, 'unknown', `GitHub returned HTTP ${res.status}.`)
  }

  let body: any
  try {
    body = await res.json()
  } catch {
    return failAll(refs, 'unknown', 'GitHub returned a malformed response body.')
  }

  refs.forEach((r, i) => {
    const key = refKey(r)
    const node = body?.data?.[`a${i}`]?.pullRequest
    if (!node) {
      out.set(key, {
        ok: false,
        kind: 'not_found',
        message: `${key} not found. It may not exist, or the token may not have access to a private repository.`,
      })
      return
    }
    out.set(key, {
      ok: true,
      data: {
        state: deriveState(String(node.state), Boolean(node.isDraft)),
        title: String(node.title ?? ''),
        url: String(node.url ?? ''),
      },
    })
  })

  return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/github.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/github.ts src/github.test.ts
git commit -m "feat: batched GraphQL fetch of pull request state and title"
```

---

## Task 4: `cache.ts` — localStorage with terminal pinning

**Files:**
- Create: `src/cache.ts`
- Test: `src/cache.test.ts`

**Interfaces:**
- Consumes: `PrState` from `./github`
- Produces:
  - `interface CacheEntry { state: PrState; title: string; url: string; fetchedAt: number }`
  - `DEFAULT_TTL_MS: number`
  - `isTerminal(state: PrState): boolean`
  - `get(key: string): CacheEntry | null`
  - `put(key: string, entry: CacheEntry): void`
  - `isFresh(entry: CacheEntry, now: number, ttlMs?: number): boolean`
  - `clear(): void`

Tests run in the `node` Vitest environment, which has no `localStorage`, so the
tests install an in-memory stub. That stub is also what makes the "storage throws"
case testable, which is the whole reason for the try/catch requirement.

- [ ] **Step 1: Write the failing tests**

Create `src/cache.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { get, put, isFresh, isTerminal, clear, DEFAULT_TTL_MS } from './cache'
import type { CacheEntry } from './cache'

class MemoryStorage {
  private data = new Map<string, string>()
  throwOnAccess = false
  get length() { return this.data.size }
  key(i: number) { return [...this.data.keys()][i] ?? null }
  getItem(k: string) {
    if (this.throwOnAccess) throw new Error('storage disabled')
    return this.data.get(k) ?? null
  }
  setItem(k: string, v: string) {
    if (this.throwOnAccess) throw new Error('storage disabled')
    this.data.set(k, v)
  }
  removeItem(k: string) { this.data.delete(k) }
  clear() { this.data.clear() }
  raw() { return this.data }
}

let store: MemoryStorage

beforeEach(() => {
  store = new MemoryStorage()
  ;(globalThis as any).localStorage = store
})

const entry = (over: Partial<CacheEntry> = {}): CacheEntry => ({
  state: 'open', title: 'A title', url: 'https://example.test/1', fetchedAt: 1000, ...over,
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

describe('put / get', () => {
  it('round-trips an entry', () => {
    put('avride/av#1', entry())
    expect(get('avride/av#1')).toEqual(entry())
  })

  it('returns null for a miss', () => {
    expect(get('nope/nope#1')).toBeNull()
  })

  it('namespaces keys with a schema version', () => {
    put('avride/av#1', entry())
    expect([...store.raw().keys()][0]).toBe('logseq-pr-badges:v1:avride/av#1')
  })

  it('reads corrupt JSON as a miss', () => {
    store.setItem('logseq-pr-badges:v1:avride/av#1', '{not json')
    expect(get('avride/av#1')).toBeNull()
  })

  it('reads an entry with missing fields as a miss', () => {
    store.setItem('logseq-pr-badges:v1:avride/av#1', JSON.stringify({ state: 'open' }))
    expect(get('avride/av#1')).toBeNull()
  })

  it('reads an unknown state as a miss', () => {
    store.setItem('logseq-pr-badges:v1:avride/av#1', JSON.stringify(entry({ state: 'exploded' as never })))
    expect(get('avride/av#1')).toBeNull()
  })

  it('survives storage that throws on read', () => {
    store.throwOnAccess = true
    expect(() => get('avride/av#1')).not.toThrow()
    expect(get('avride/av#1')).toBeNull()
  })

  it('survives storage that throws on write', () => {
    store.throwOnAccess = true
    expect(() => put('avride/av#1', entry())).not.toThrow()
  })
})

describe('isFresh', () => {
  it('treats a recent non-terminal entry as fresh', () => {
    expect(isFresh(entry({ fetchedAt: 1000 }), 1000 + DEFAULT_TTL_MS - 1)).toBe(true)
  })

  it('treats an expired non-terminal entry as stale', () => {
    expect(isFresh(entry({ fetchedAt: 1000 }), 1000 + DEFAULT_TTL_MS + 1)).toBe(false)
  })

  it('treats a merged entry as fresh forever', () => {
    expect(isFresh(entry({ state: 'merged', fetchedAt: 0 }), 1e12)).toBe(true)
  })

  it('treats a closed entry as fresh forever', () => {
    expect(isFresh(entry({ state: 'closed', fetchedAt: 0 }), 1e12)).toBe(true)
  })

  it('honours a custom ttl', () => {
    expect(isFresh(entry({ fetchedAt: 0 }), 500, 1000)).toBe(true)
    expect(isFresh(entry({ fetchedAt: 0 }), 1500, 1000)).toBe(false)
  })
})

describe('clear', () => {
  it('removes only this plugin keys', () => {
    put('avride/av#1', entry())
    store.setItem('someone-elses-key', 'keep me')
    clear()
    expect(get('avride/av#1')).toBeNull()
    expect(store.getItem('someone-elses-key')).toBe('keep me')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/cache.test.ts`
Expected: FAIL — cannot resolve `./cache`.

- [ ] **Step 3: Write the implementation**

Create `src/cache.ts`:
```ts
import type { PrState } from './github'

export interface CacheEntry {
  state: PrState
  title: string
  url: string
  fetchedAt: number
}

const PREFIX = 'logseq-pr-badges:v1:'
export const DEFAULT_TTL_MS = 15 * 60 * 1000

const STATES: readonly string[] = ['open', 'draft', 'merged', 'closed']

export function isTerminal(state: PrState): boolean {
  return state === 'merged' || state === 'closed'
}

export function get(key: string): CacheEntry | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(PREFIX + key)
  } catch {
    return null
  }
  if (raw === null) return null

  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { state, title, url, fetchedAt } = parsed as Record<string, unknown>
    if (typeof state !== 'string' || !STATES.includes(state)) return null
    if (typeof title !== 'string') return null
    if (typeof url !== 'string') return null
    if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) return null
    return { state: state as PrState, title, url, fetchedAt }
  } catch {
    return null
  }
}

export function put(key: string, entry: CacheEntry): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(entry))
  } catch {
    // Storage is disabled or full. The cache is best-effort; a miss just
    // means one more request next render.
  }
}

export function isFresh(
  entry: CacheEntry, now: number, ttlMs: number = DEFAULT_TTL_MS,
): boolean {
  if (isTerminal(entry.state)) return true
  return now - entry.fetchedAt < ttlMs
}

export function clear(): void {
  try {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k !== null && k.startsWith(PREFIX)) doomed.push(k)
    }
    for (const k of doomed) localStorage.removeItem(k)
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/cache.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cache.ts src/cache.test.ts
git commit -m "feat: localStorage cache with terminal-state pinning"
```

---

## Task 5: `badge.ts` — escaped HTML rendering

Colors are **not** in this module. `badge.ts` emits a `data-state` attribute and the
stylesheet in Task 6 carries the hex values, which keeps snapshots stable and puts
light/dark handling in one place.

**Files:**
- Create: `src/badge.ts`
- Test: `src/badge.test.ts`

**Interfaces:**
- Consumes: `CacheEntry` from `./cache`, `PrState` from `./github`
- Produces:
  - `escapeHtml(s: string): string`
  - `renderBadge(entry: CacheEntry, key: string, opts: { stale: boolean }): string`
  - `renderSkeleton(key: string): string`
  - `renderError(message: string): string`

- [ ] **Step 1: Write the failing tests**

Create `src/badge.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { escapeHtml, renderBadge, renderSkeleton, renderError } from './badge'
import type { CacheEntry } from './cache'

const entry = (over: Partial<CacheEntry> = {}): CacheEntry => ({
  state: 'merged',
  title: 'EMB-2887: Bringup and service rootfs',
  url: 'https://github.com/avride/av/pull/36812',
  fetchedAt: 0,
  ...over,
})

describe('escapeHtml', () => {
  it('escapes the five dangerous characters', () => {
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;')
  })
  it('escapes ampersands before anything else', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
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
    const html = renderBadge(
      entry({ title: '<script>alert(1)</script>' }), 'avride/av#36812', { stale: false },
    )
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes a hostile url', () => {
    const html = renderBadge(
      entry({ url: 'https://x.test/"><script>alert(1)</script>' }),
      'avride/av#36812', { stale: false },
    )
    expect(html).not.toContain('<script>')
  })

  it('marks a stale badge', () => {
    expect(renderBadge(entry(), 'avride/av#36812', { stale: true }))
      .toContain('data-stale="true"')
  })

  it('omits the stale marker when fresh', () => {
    expect(renderBadge(entry(), 'avride/av#36812', { stale: false }))
      .not.toContain('data-stale="true"')
  })

  it('renders a distinct icon per state', () => {
    const states = (['open', 'draft', 'merged', 'closed'] as const)
      .map((s) => renderBadge(entry({ state: s }), 'k', { stale: false }))
    expect(new Set(states).size).toBe(4)
  })

  it('names the state and ref in the tooltip', () => {
    const html = renderBadge(entry(), 'avride/av#36812', { stale: false })
    expect(html).toContain('title="merged')
    expect(html).toContain('avride/av#36812')
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
    expect(html).toContain('&lt;ref&gt;')
    expect(html).not.toContain('<ref>')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/badge.test.ts`
Expected: FAIL — cannot resolve `./badge`.

- [ ] **Step 3: Write the implementation**

Create `src/badge.ts`. The four `d` attributes are Primer octicons at 16px, MIT
licensed, copied verbatim from `primer/octicons`:

```ts
import type { CacheEntry } from './cache'
import type { PrState } from './github'

const ICON_PATHS: Record<PrState, string> = {
  open: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
  merged: 'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z',
  closed: 'M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z',
  draft: 'M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z',
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function icon(state: PrState): string {
  return (
    `<svg class="pr-badge__icon" viewBox="0 0 16 16" width="16" height="16" ` +
    `aria-hidden="true" focusable="false"><path d="${ICON_PATHS[state]}"/></svg>`
  )
}

export function renderBadge(
  entry: CacheEntry, key: string, opts: { stale: boolean },
): string {
  const staleAttr = opts.stale ? ' data-stale="true"' : ''
  const tooltip = escapeHtml(`${entry.state} · ${key}`)
  return (
    `<a class="pr-badge" data-state="${entry.state}"${staleAttr} ` +
    `href="${escapeHtml(entry.url)}" target="_blank" rel="noopener noreferrer" ` +
    `title="${tooltip}">${icon(entry.state)}` +
    `<span class="pr-badge__title">${escapeHtml(entry.title)}</span></a>`
  )
}

export function renderSkeleton(key: string): string {
  return (
    `<span class="pr-badge pr-badge--skeleton" aria-busy="true" ` +
    `title="${escapeHtml(`loading ${key}`)}">` +
    `<span class="pr-badge__title">${escapeHtml(key)}</span></span>`
  )
}

export function renderError(message: string): string {
  const safe = escapeHtml(message)
  return (
    `<span class="pr-badge pr-badge--error" title="${safe}">` +
    `<span class="pr-badge__title">⚠ ${safe}</span></span>`
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/badge.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/badge.ts src/badge.test.ts
git commit -m "feat: render escaped PR badge markup with Primer octicons"
```

---

## Task 6: `index.ts` — plugin wiring

This module talks to the plugin host and is verified by hand in Task 7, not by unit
tests. Mocking the Logseq host would prove very little.

**Files:**
- Create: `src/index.ts`
- Delete: `src/smoke.test.ts` (the harness is proven by four real suites now)

**Interfaces:**
- Consumes: `parseRef`, `refKey` (`./ref`); `fetchPrs` (`./github`);
  `get`, `put`, `isFresh`, `clear`, `CacheEntry` (`./cache`);
  `renderBadge`, `renderSkeleton`, `renderError` (`./badge`)
- Produces: nothing importable — this is the entry point

Three behaviours worth understanding before writing it:

1. **The `display: inline` fix is pure CSS.** Logseq wraps macros in
   `[:div.macro {:data-macro-name name}]`, which is block-level. A selector on
   `data-macro-name` would hit every other plugin's renderers, so scope on our own
   class instead: `div.macro:has(.pr-badge) { display: inline; }`. `:has()` is
   available in this Electron's Chromium. This refines the spec, which proposed
   walking the DOM imperatively — scoping on `.pr-badge` gives the same precision
   with no DOM access from the plugin's iframe.

2. **Async redraws target a slot that may be gone.** When a fetch resolves we call
   `provideUI` again with the same `slot` and `key`. If the block re-rendered in the
   meantime the slot no longer exists and the update is silently dropped — which is
   fine and self-healing, because the cache is now warm and the next render draws
   the real badge immediately. Do not add machinery to chase stale slots.

3. **Batching.** Refs discovered during a render pass are queued and flushed on a
   50 ms debounce, up to 25 per request, so a journal page with many badges costs
   one round trip rather than one per badge.

- [ ] **Step 1: Write the implementation**

Create `src/index.ts`:
```ts
import '@logseq/libs'
import { parseRef, refKey } from './ref'
import type { PrRef } from './ref'
import { fetchPrs } from './github'
import { get, put, isFresh, clear, DEFAULT_TTL_MS } from './cache'
import type { CacheEntry } from './cache'
import { renderBadge, renderSkeleton, renderError } from './badge'

const MACRO = ':pr'
const BATCH_DEBOUNCE_MS = 50
const BATCH_MAX = 25
const NOT_FOUND_TTL_MS = 5 * 60 * 1000

const STYLES = `
.pr-badge {
  display: inline-flex; align-items: center; gap: 0.35em;
  vertical-align: baseline; text-decoration: none;
}
.pr-badge__icon { flex: none; position: relative; top: 0.15em; }
.pr-badge[data-stale="true"] { opacity: 0.6; }
.pr-badge--skeleton { opacity: 0.5; font-style: italic; }
.pr-badge--error { color: #d1242f; }

.pr-badge[data-state="open"]   { color: #1a7f37; }
.pr-badge[data-state="merged"] { color: #8250df; }
.pr-badge[data-state="closed"] { color: #d1242f; }
.pr-badge[data-state="draft"]  { color: #59636e; }

html[data-theme="dark"] .pr-badge[data-state="open"]   { color: #3fb950; }
html[data-theme="dark"] .pr-badge[data-state="merged"] { color: #ab7df8; }
html[data-theme="dark"] .pr-badge[data-state="closed"] { color: #f85149; }
html[data-theme="dark"] .pr-badge[data-state="draft"]  { color: #9198a1; }
html[data-theme="dark"] .pr-badge--error { color: #f85149; }

/* Logseq wraps macros in a block-level div.macro. Scope the inline fix to our
   own badges so other plugins' renderers are untouched. */
div.macro:has(.pr-badge) { display: inline; }
`

/** Slots currently showing a badge, so a refresh can redraw them. */
const liveSlots = new Map<string, { slot: string; key: string }>()

/** Refs seen this render pass that still need fetching. */
const pending = new Map<string, PrRef>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

/** Refs that came back not-found, with the time we learned that. */
const notFound = new Map<string, number>()

/** While rate limited, the time after which it is worth trying again. */
let rateLimitedUntil = 0

function token(): string {
  return String((logseq.settings as Record<string, unknown> | undefined)?.['token'] ?? '').trim()
}

function ttlMs(): number {
  const minutes = Number((logseq.settings as Record<string, unknown> | undefined)?.['ttlMinutes'])
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : DEFAULT_TTL_MS
}

function draw(slot: string, key: string, html: string): void {
  logseq.provideUI({ key: `pr-${slot}`, slot, template: html, reset: true })
  liveSlots.set(slot, { slot, key })
}

function drawFromCache(slot: string, key: string, entry: CacheEntry): void {
  draw(slot, key, renderBadge(entry, key, { stale: !isFresh(entry, Date.now(), ttlMs()) }))
}

function scheduleFlush(): void {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, BATCH_DEBOUNCE_MS)
}

async function flush(): Promise<void> {
  if (pending.size === 0) return
  const batch = [...pending.entries()].slice(0, BATCH_MAX)
  for (const [k] of batch) pending.delete(k)

  if (Date.now() < rateLimitedUntil) {
    for (const [key] of batch) {
      const cached = get(key)
      redrawKey(key, cached !== null
        ? renderBadge(cached, key, { stale: true })
        : renderError('GitHub rate limit reached; retrying shortly.'))
    }
    return
  }

  const tok = token()
  if (tok === '') {
    for (const [key] of batch) redrawKey(key, renderError(`no GitHub token set — open the PR Badges plugin settings (${key})`))
    return
  }

  const results = await fetchPrs(batch.map(([, r]) => r), tok, fetch)

  for (const [key] of batch) {
    const outcome = results.get(key)
    if (outcome === undefined) continue

    if (outcome.ok) {
      const entry: CacheEntry = { ...outcome.data, fetchedAt: Date.now() }
      put(key, entry)
      redrawKey(key, renderBadge(entry, key, { stale: false }))
      continue
    }

    if (outcome.kind === 'not_found') {
      notFound.set(key, Date.now())
      redrawKey(key, renderError(outcome.message))
      continue
    }

    if (outcome.kind === 'rate_limit') {
      rateLimitedUntil = Date.now() + (outcome.retryAfterMs ?? 60_000)
    }

    // auth / rate_limit / network / unknown: prefer last-known state, dimmed.
    const cached = get(key)
    if (cached !== null) {
      redrawKey(key, renderBadge(cached, key, { stale: true }))
    } else {
      redrawKey(key, renderError(outcome.message))
    }
  }

  if (pending.size > 0) scheduleFlush()
}

function redrawKey(key: string, html: string): void {
  for (const [slot, live] of liveSlots) {
    if (live.key === key) draw(slot, key, html)
  }
}

function handleMacro(slot: string, args: string[]): void {
  if (args[0] !== MACRO) return

  const parsed = parseRef(args[1] ?? '')
  if (!parsed.ok) {
    logseq.provideUI({ key: `pr-${slot}`, slot, template: renderError(parsed.reason), reset: true })
    return
  }

  const key = refKey(parsed.ref)
  const cached = get(key)

  if (cached !== null) {
    drawFromCache(slot, key, cached)
    if (isFresh(cached, Date.now(), ttlMs())) return
  } else {
    const missedAt = notFound.get(key)
    if (missedAt !== undefined && Date.now() - missedAt < NOT_FOUND_TTL_MS) {
      logseq.provideUI({
        key: `pr-${slot}`, slot, reset: true,
        template: renderError(`${key} not found. It may not exist, or the token may not have access to a private repository.`),
      })
      liveSlots.set(slot, { slot, key })
      return
    }
    draw(slot, key, renderSkeleton(key))
  }

  pending.set(key, parsed.ref)
  scheduleFlush()
}

function main(): void {
  logseq.useSettingsSchema([
    {
      key: 'token',
      type: 'string',
      default: '',
      title: 'GitHub token',
      description:
        'A personal access token with `repo` scope. Required to read pull requests in private repositories.',
    },
    {
      key: 'ttlMinutes',
      type: 'number',
      default: 15,
      title: 'Refresh interval (minutes)',
      description:
        'How long an open or draft pull request is cached before it is checked again. Merged and closed pull requests are never re-checked.',
    },
  ])

  logseq.provideStyle(STYLES)

  logseq.App.onMacroRendererSlotted(({ slot, payload }) => {
    handleMacro(slot, payload.arguments ?? [])
  })

  logseq.App.registerCommandPalette(
    { key: 'pr-badges-refresh', label: 'Refresh PR states' },
    () => {
      clear()
      notFound.clear()
      for (const [, live] of liveSlots) pending.set(live.key, parseRefOrThrow(live.key))
      scheduleFlush()
      logseq.UI.showMsg('PR states refreshing…', 'success')
    },
  )
}

function parseRefOrThrow(key: string): PrRef {
  const parsed = parseRef(key)
  if (!parsed.ok) throw new Error(`unreachable: cached key is unparseable: ${key}`)
  return parsed.ref
}

logseq.ready(main).catch(console.error)
```

- [ ] **Step 2: Remove the smoke test**

```bash
rm src/smoke.test.ts
```

- [ ] **Step 3: Typecheck and build**

```bash
pnpm typecheck
pnpm test
pnpm build
```
Expected: no type errors; all four suites pass; `dist/index.html` written.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: wire macro renderer, batching, settings and refresh command"
```

---

## Task 7: Install, configure, and verify by hand

**Files:**
- Create: `README.md`
- Modify: `~/Documents/logseq/config.edn` (the `:macros` entry, currently `{}`)

**Interfaces:**
- Consumes: a built `dist/` from Task 6
- Produces: a working plugin in Logseq and a documented setup

- [ ] **Step 1: Add the macro to `config.edn`**

Change line 268 of `~/Documents/logseq/config.edn` from `:macros {}` to:

```clojure
:macros {"pr" "{{renderer :pr, $1}}"}
```

Single `$1` is deliberate: `macro-subs` only substitutes as many `$N` as arguments
supplied, so a second slot would survive as the literal string `"$2"`.

- [ ] **Step 2: Load the plugin**

In Logseq: `⋯` → Plugins → `Load unpacked plugin` → select
`~/devel/logseq-pr-badges`. Then open the plugin's settings and paste a GitHub token
with `repo` scope.

- [ ] **Step 3: Create a scratch page with the verification cases**

Create a page named `pr-badges-test` with these blocks:

```markdown
- open: {{pr avride/av#36812}}
- merged: {{pr avride/av#27822}}
- rootfs: {{pr avride/rootfs#1780}}
- malformed: {{pr 36812}}
- malformed: {{pr https://github.com/avride/av/pull/36812}}
- missing: {{pr avride/av#99999999}}
- inline text before {{pr avride/av#36812}} and after
```

- [ ] **Step 4: Walk the verification checklist**

Confirm each, and record the result in the commit message:

- [ ] `avride/av#36812` renders a **gray draft** icon (verified via the API on
      2026-08-28 as `OPEN` + `isDraft: true`).
- [ ] A merged PR renders a **purple** merge icon.
- [ ] A closed PR renders a **red** closed icon.
- [ ] Both malformed refs render `⚠` with a tooltip naming `owner/repo#number`,
      and neither makes a network request.
- [ ] The nonexistent number renders `⚠` whose tooltip mentions both
      non-existence and token access.
- [ ] The inline case stays on one line — the `div.macro:has(.pr-badge)` rule works.
- [ ] Colors are legible in dark mode (the graph runs the default dark theme);
      toggle to light and confirm there too.
- [ ] No `#36812` tag pages appeared in All Pages.
- [ ] Reload Logseq: badges paint immediately from cache, with no skeleton flash.
- [ ] Disable networking, reload: cached badges still render, dimmed.
- [ ] Run `Refresh PR states` from the command palette: badges re-fetch.
- [ ] Clear `localStorage` for the app, reload: skeletons appear, then resolve.

- [ ] **Step 5: Write `README.md`**

```markdown
# logseq-pr-badges

Renders GitHub pull request state inline in Logseq, the way GitHub does.

    {{pr avride/av#36812}}

→ a colored state octicon (open / draft / merged / closed) followed by the PR
title, linking to the pull request.

## Install

1. Enable Logseq's plugin system: Settings → Advanced → Developer mode + Plug-in system.
2. `pnpm install && pnpm build`
3. Logseq → `⋯` → Plugins → Load unpacked plugin → this directory.
4. Open the plugin settings and paste a GitHub token with `repo` scope.
5. Add the macro to your graph's `logseq/config.edn`:

       :macros {"pr" "{{renderer :pr, $1}}"}

## Syntax

Exactly `{{pr owner/repo#number}}`. Bare numbers and pull request URLs are
rejected with a visible warning rather than guessed at.

## How it caches

State and title are cached in `localStorage`. Merged and closed pull requests are
terminal and never re-checked. Open and draft ones expire after the configured
interval (default 15 minutes). `Refresh PR states` in the command palette clears
the cache and re-fetches everything on screen.

Titles are **not** written into your markdown, so Logseq search will not match a
block by pull request title.

## Development

    pnpm test        # unit tests for the four pure modules
    pnpm typecheck
    pnpm build
```

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: add README with install, syntax and caching notes"
```

---

## Task 8: Phase 2 — declarative install via home-manager

Do this only once Task 7's checklist passes. It changes a different repo.

**Files:**
- Create: `~/devel/dotfiles/nix/home/logseq/default.nix`
- Modify: whichever host or profile imports home modules — check
  `~/devel/dotfiles/nix/hosts/macbook.nix` and `nix/profiles/work.nix` for the
  existing import pattern before adding.

**Interfaces:**
- Consumes: a working plugin build from Task 7
- Produces: `~/.logseq/plugins/logseq-pr-badges/` and a settings file, both managed

- [ ] **Step 1: Read the existing module pattern**

```bash
sed -n '1,40p' ~/devel/dotfiles/nix/home/claude/default.nix
grep -rn "home/claude\|home/ams" ~/devel/dotfiles/nix/hosts ~/devel/dotfiles/nix/profiles
```
Follow whatever import and `sops.secrets` idiom is already there rather than
inventing a new one.

- [ ] **Step 2: Write the module**

The settings file must be **copied, not symlinked**: Logseq rewrites
`~/.logseq/settings/*.json` when settings change, and a read-only nix store symlink
would break settings persistence.

```nix
{ config, pkgs, lib, ... }:
let
  plugin = pkgs.buildNpmPackage {
    pname = "logseq-pr-badges";
    version = "0.1.0";
    src = ../../../../logseq-pr-badges;
    npmDepsHash = lib.fakeHash; # replace with the hash nix reports on first build
    installPhase = ''
      mkdir -p $out
      cp -r dist package.json icon.svg $out/
    '';
  };
in
{
  sops.secrets.github-access-token = { };

  home.file.".logseq/plugins/logseq-pr-badges".source = plugin;

  home.activation.logseqPrBadgesSettings =
    lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      settings_dir="$HOME/.logseq/settings"
      settings_file="$settings_dir/logseq-pr-badges.json"
      mkdir -p "$settings_dir"
      token=$(cat ${config.sops.secrets.github-access-token.path})
      umask 077
      ${pkgs.jq}/bin/jq -n --arg t "$token" \
        '{ token: $t, ttlMinutes: 15 }' > "$settings_file"
    '';
}
```

- [ ] **Step 3: Build and get the real dependency hash**

```bash
cd ~/devel/dotfiles
nix build .#darwinConfigurations.$(hostname -s).system 2>&1 | tail -20
```
Expected: a hash mismatch naming the correct `npmDepsHash`. Replace
`lib.fakeHash` with it and rebuild.

If `buildNpmPackage` fights the pnpm lockfile, switch to
`pkgs.pnpm.fetchDeps` + `pnpm install --offline`, or commit `dist/` and drop the
build step entirely — the plugin is small and the goal here is a declarative
install, not a reproducible bundler.

- [ ] **Step 4: Apply and verify**

```bash
darwin-rebuild switch --flake ~/devel/dotfiles
ls -l ~/.logseq/plugins/logseq-pr-badges/
stat -f '%Sp' ~/.logseq/settings/logseq-pr-badges.json
```
Expected: plugin directory present; settings file mode `-rw-------`.

Then remove the unpacked plugin from Logseq's plugin list, restart, and confirm
badges still render — this proves the managed install works on its own.

- [ ] **Step 5: Commit the dotfiles change**

```bash
cd ~/devel/dotfiles
git add nix/
git commit -m "feat(logseq): install logseq-pr-badges plugin and settings declaratively"
```
