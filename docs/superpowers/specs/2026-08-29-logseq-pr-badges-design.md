# logseq-pr-badges — Design

**Date:** 2026-08-29
**Status:** Approved, pending implementation plan

## Problem

Journal blocks reference GitHub pull requests as plain markdown links:

```markdown
- [EMB-2887: Bringup and service rootfs for redbrain](https://github.com/avride/av/pull/36812)
```

Nothing in the note says whether that PR is open, merged, closed, or draft. Answering
"did this land?" means opening the link. GitHub itself solves this with a colored
octicon next to every PR reference; this plugin brings the same affordance into Logseq.

## Scope

**In:** GitHub pull requests, four states — open, draft, merged, closed.

**Out:** GitHub issues, YouTrack tickets, branches, commits, review status, CI status.
Issues were considered and dropped: the graph contains zero GitHub issue links today.
YouTrack (`EMB-xxxx`) is a second API with a second token and a second state
vocabulary — a separate project if it is ever wanted.

## Environment

| Fact | Value |
|---|---|
| Logseq | 0.10.15, file-based Markdown graph |
| Install | Nix (`nix/darwin/default.nix`, electron_40 override) |
| Graph root | `~/Documents` (`journals/`, `pages/`, `logseq/config.edn`) |
| Graph VCS | none (checked when hydration was still on the table; the final design never writes to the graph, so this no longer matters) |
| `logseq/custom.css` | exists, empty |
| Plugins installed | none; `~/.logseq/config/plugins.edn` is `{}` |
| Node / package manager | Node 24.18.0, pnpm (`npm` is aliased to pnpm) |
| Existing secret | `sops.secrets.github-access-token` in dotfiles |
| Logseq HTTP API | live on 127.0.0.1:12315 (unrelated to this plugin; used by the MCP server) |

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Authoring syntax | `{{pr owner/repo#number}}` | One strict format. No defaults, no bare numbers, no URL form. |
| Title source | Fetched, cached in `localStorage`, rendered from cache | Never inlined into the macro; the plugin never writes to a block. |
| Freshness | Cache with terminal-state pinning | Merged and closed never change; only open/draft re-poll on a TTL. |
| Packaging | Own repo; unpacked during development, Nix module afterwards | Avoids Nix packaging work against code whose shape is still moving. |

Two simplifications were applied after the first design review, and both removed
code rather than adding it:

1. **No hydration.** An earlier design had the plugin rewrite `{{pr N}}` into
   `{{pr N, Title}}` so the title landed in the file. Dropped. This deletes an
   entire module and the whole write-race guard (`checkEditing`, re-read before
   write, sanitizing `}}` and newlines out of fetched titles).
2. **One strict ref format.** An earlier design accepted bare numbers against a
   default repo, plus pasted URLs. Dropped in favor of `owner/repo#number` only.

### Accepted trade-off

Titles live only in `localStorage`, never in the markdown. Therefore
`grep bringup` over the graph finds nothing, and Logseq's own search cannot match
a block by PR title. This was chosen knowingly, in exchange for a plugin that
never writes to the graph. A cold cache (new machine, cleared site data) shows
skeletons until the first batch resolves — a one-time cost per machine, since
most refs resolve to terminal states that are then pinned forever.

## Verified mechanics

These were confirmed against Logseq 0.10.15 and mldoc source, not assumed. They are
the load-bearing assumptions of the whole design and are recorded here so a future
reader does not have to re-derive them.

**1. A `:macros` entry can bridge onto the plugin renderer hook.**
`frontend.components.block/render-macro` re-parses substituted macro content through
`mldoc/->edn` and renders the resulting AST, which routes `Macro` nodes back into
`macro-cp`. So a config.edn macro expanding to `{{renderer ...}}` does dispatch to
the plugin. This is what allows a friendly `{{pr ...}}` instead of forcing the user
to type `{{renderer :pr, ...}}`.

**2. The renderer branch is gated on the plugin system being enabled.**
`macro-cp` has `(= name "renderer") (when config/lsp-enabled? ...)`. With plugins
disabled, macros render nothing. The graph currently has zero plugins installed, so
enabling the plugin system is a required setup step.

**3. `#` and `/` are literal inside macro arguments.**
mldoc's `macro_arg` falls back to `take_while1 (fun c -> not @@ List.mem c [','])` —
raw characters up to a comma, with no recursive inline parsing. `#36812` is therefore
not parsed as a tag and creates no tag pages. `{{pr avride/av#36812}}` yields
`Macro { name = "pr"; arguments = ["avride/av#36812"] }`.

**4. `,` is the only argument separator, and arguments are space-trimmed.**
From `macro_args`: `sep_by (char ',') (optional spaces *> macro_arg config <* optional spaces)`.
Since `owner/repo#number` cannot contain a comma, single-argument parsing is safe.

**5. `macro-subs` only substitutes as many `$N` as arguments supplied.**
An unsupplied `$2` survives as the literal string `"$2"`. The single-argument macro
template avoids this entirely — recorded because it is a real trap for any future
two-argument macro.

**6. Macros render inside `[:div.macro {:data-macro-name name}]`.**
That is block-level, so an inline badge would break onto its own line. Note that
`data-macro-name` is `"renderer"` for *every* plugin renderer, so a CSS selector on
it would affect unrelated plugins.

## Architecture

New repo `~/devel/logseq-pr-badges`. Vite + TypeScript, `@logseq/libs` 0.0.17, pnpm.
Four pure modules plus one host-coupled wiring module.

| Module | Responsibility | Depends on |
|---|---|---|
| `src/ref.ts` | Parse one macro argument into a `PrRef`; produce canonical keys | nothing |
| `src/github.ts` | Fetch PR state + title; batch many refs into one GraphQL request | `fetch` |
| `src/cache.ts` | `localStorage` store; TTL and terminal-state pinning | `localStorage` |
| `src/badge.ts` | Render a cache entry to escaped HTML (octicon, color, link) | nothing |
| `src/index.ts` | Wiring: renderer hook, settings schema, refresh command, styles | `@logseq/libs` |

Only `index.ts` touches the plugin host. The other four are ordinary functions over
plain data and are unit-testable without a Logseq instance.

### Interfaces

```ts
// ref.ts
export interface PrRef { owner: string; repo: string; number: number }
export type ParseResult =
  | { ok: true; ref: PrRef }
  | { ok: false; reason: string }
export function parseRef(raw: string): ParseResult
export function refKey(ref: PrRef): string        // "avride/av#36812"

// github.ts
export type PrState = 'open' | 'draft' | 'merged' | 'closed'
export interface PrData { state: PrState; title: string; url: string }
export type FetchOutcome =
  | { ok: true; data: PrData }
  | { ok: false; kind: 'not_found' | 'auth' | 'rate_limit' | 'network' | 'unknown';
      message: string }
export function fetchPrs(
  refs: PrRef[], token: string, fetchImpl?: typeof fetch
): Promise<Map<string, FetchOutcome>>

// cache.ts
export interface CacheEntry { state: PrState; title: string; url: string; fetchedAt: number }
export function get(key: string): CacheEntry | null
export function put(key: string, entry: CacheEntry): void
export function isFresh(entry: CacheEntry, now: number, ttlMs: number): boolean
export function clear(): void

// badge.ts
export function renderBadge(entry: CacheEntry, opts: { stale: boolean }): string
export function renderSkeleton(): string
export function renderError(message: string): string
```

### State derivation

GitHub returns `state` as `OPEN | CLOSED | MERGED` plus a separate `isDraft` flag
that is only meaningful while open:

| GitHub | Our state | Octicon | Terminal |
|---|---|---|---|
| `MERGED` | `merged` | `git-merge` | yes |
| `CLOSED` | `closed` | `git-pull-request-closed` | yes |
| `OPEN` + `isDraft` | `draft` | `git-pull-request-draft` | no |
| `OPEN` | `open` | `git-pull-request` | no |

Terminal is derived from state, never stored. Octicons ship inlined as SVG (MIT
licensed). Colors start from GitHub Primer's foreground tokens with light and dark
variants; exact hex values are to be read off Primer during implementation rather
than trusted to memory.

### Cache

Key: `logseq-pr-badges:v1:<owner>/<repo>#<number>`. The `v1` segment is a schema
version — bumping it self-invalidates every entry when the shape changes.

`isFresh` returns true unconditionally for terminal states. Non-terminal entries
are fresh for a configurable TTL, default 15 minutes.

### Data flow

For each `{{pr avride/av#36812}}`:

1. Logseq expands the config.edn macro to `{{renderer :pr, avride/av#36812}}`,
   re-parses it, and fires the renderer hook with `payload.arguments` and
   `payload.uuid`.
2. `index.ts` checks `arguments[0] === ':pr'` and parses `arguments[1]` via `parseRef`.
3. Cache lookup:
   - hit + terminal → draw immediately, never refetch
   - hit + fresh → draw immediately
   - hit + stale → draw immediately from cache, refetch in background, redraw
   - miss → draw skeleton, enqueue the ref
4. The pending queue flushes on a 50 ms debounce, batching up to 25 refs into one
   aliased GraphQL query. Results are written to cache, then each slot redraws.
5. Output is injected with `logseq.provideUI({ key, slot, template })`.
6. The renderer walks up from its slot and sets `display: inline` on the `.macro`
   ancestor imperatively — deterministic, and avoids a `data-macro-name` selector
   that would hit every other plugin's renderers (see Verified mechanics #6).

### Error handling

Every path renders something. A note should never show a blank or an error box.

| Condition | Behavior |
|---|---|
| Malformed ref | Inline `⚠` with tooltip naming the expected format. No network. |
| No token configured | Inline `⚠` with tooltip pointing at plugin settings. No network. |
| `NOT_FOUND` | Inline `⚠`. Tooltip must say the PR may not exist **or** the token may lack access — GitHub GraphQL returns `NOT_FOUND` for both, and they are indistinguishable. Negative-cached for 5 minutes so it does not refetch on every render; never pinned terminal, since fixing the token should recover. |
| `401` / bad token | Dimmed last-known entry if cached, else plain link. Logged once, not per slot. |
| Rate limited | Dimmed last-known entry; back off until the reset timestamp. |
| Network error / offline | Dimmed last-known entry; plain GitHub link if the cache is cold. |

`localStorage` access is wrapped in try/catch throughout — it throws outright in
some contexts, and a corrupt or partially-written entry must be treated as a miss
rather than propagating.

### Security

Fetched PR titles are interpolated into HTML strings passed to `provideUI`, so every
title is HTML-escaped before insertion. This is not hypothetical: a PR title is free
text and can contain markup. The token is read from plugin settings and is sent only
to `api.github.com`.

## Testing

Vitest over the four pure modules.

- **`ref.ts`** — parse matrix: valid ref; bare number; URL form; missing owner;
  missing `#`; non-numeric number; surrounding whitespace; dots, dashes and
  underscores in owner and repo names. The rejected forms matter as much as the
  accepted one, since rejection is now user-visible.
- **`cache.ts`** — fresh vs stale by TTL; terminal entries never stale; version-prefix
  invalidation; corrupt JSON treated as a miss; `localStorage` throwing is survivable.
- **`badge.ts`** — snapshot per state; stale dimming; error markup; and an explicit
  escaping test with a title containing `<script>`.
- **`github.ts`** — against a mocked `fetch`: batch aliasing; partial results where
  one ref resolves and another is `NOT_FOUND`; 401; rate limit; network throw;
  malformed JSON body.

`index.ts` is host-coupled and gets a written manual checklist instead of a mocked
harness — mocking the plugin host would prove very little. The checklist:
the known draft `avride/av#36812`; a merged PR; a closed PR; a malformed ref; a
nonexistent number; airplane mode with a warm cache; and airplane mode with a cold
cache.

## Phasing

**Phase 1 — working plugin, installed by hand.**
Vite build; the five modules; unit tests; loaded through Logseq's *Load unpacked
plugin*; token pasted into plugin settings; one line added to
`~/Documents/logseq/config.edn`:

```clojure
:macros {"pr" "{{renderer :pr, $1}}"}
```

Requires enabling Logseq's plugin system (Verified mechanics #2).

**Phase 2 — declarative install.**
A home-manager module in the dotfiles repo that builds the plugin into
`~/.logseq/plugins/` and supplies the token from the existing
`sops.secrets.github-access-token`.

Constraint found while checking: Logseq rewrites `~/.logseq/settings/*.json` itself
when settings change, so a read-only `home.file` symlink would break settings
persistence. Phase 2 must use an activation script that *copies* the settings file
at mode 0600.

## Risks and open items

1. **Token scope.** `github-access-token` must carry `repo` scope to read a private
   repo such as `avride/av`. Not yet verified — the secret has not been decrypted.
   This is the first implementation step, because nothing works without it, and a
   scope failure surfaces as an indistinguishable `NOT_FOUND`.
2. **Plugin system disabled.** Must be turned on before anything renders at all.
3. **Cold-cache first load.** Accepted and documented above, not mitigated.
4. **Logseq upgrades.** Every mechanic in Verified mechanics is an internal detail of
   0.10.15, not a public API contract. A Logseq upgrade could change macro expansion
   or the `.macro` wrapper. The mitigation is that these are written down here, so a
   break is diagnosable rather than mysterious.
