# User checklist — finish Phase 1 (logseq-pr-badges)

Manual GUI steps that cannot be automated. Do these in order.

## 1. Enable Logseq's plugin system

- [ ] Logseq → Settings → Advanced → enable **Developer mode**.
- [ ] Same screen → enable **Plug-in system**.
- [ ] Restart Logseq. (Without this, `{{renderer}}` never fires — nothing will
      render, even with the macro and plugin correctly installed.)

## 2. Load the plugin

- [ ] `⋯` → Plugins → **Load unpacked plugin** → select
      `/Users/shaugh/devel/logseq-pr-badges`.

## 3. Configure the GitHub token

- [ ] Open the plugin's settings.
- [ ] Paste a GitHub token with `repo` scope.

(Note: the graph's `logseq/config.edn` has already had its `:macros` entry set
to `{"pr" "{{renderer :pr, $1}}"}`, with a backup at
`~/Documents/logseq/config.edn.bak-pr-badges`. No action needed there.)

## 4. Create the test page

Create a page named `pr-badges-test` with exactly these blocks:

```markdown
- draft:     {{pr avride/av#36812}}
- merged:    {{pr avride/av#27822}}
- closed:    {{pr avride/av#36935}}
- bad ref:   {{pr 36812}}
- bad ref:   {{pr https://github.com/avride/av/pull/36812}}
- missing:   {{pr avride/av#99999999}}
- inline text before {{pr avride/av#36812}} and after
```

## 5. Walk the verification checklist

- [ ] `avride/av#36812` renders a **gray** draft icon.
- [ ] `avride/av#27822` renders a **purple** merged icon.
- [ ] `avride/av#36935` renders a **red** closed icon.
- [ ] (For reference, an open PR renders a **green** open icon — none of the
      three test refs above are open, so confirm this incidentally if you spot
      one elsewhere, otherwise skip.)
- [ ] Both bad refs (`{{pr 36812}}` and `{{pr https://github.com/avride/av/pull/36812}}`)
      render `⚠` with a tooltip naming the expected `owner/repo#number` format,
      and neither makes a network request.
- [ ] The missing PR (`avride/av#99999999`) renders `⚠` whose tooltip mentions
      both non-existence and token access.
- [ ] The inline case ("inline text before ... and after") stays on one line —
      the `div.macro:has(.pr-badge)` CSS rule is working.
- [ ] Colors are legible in dark mode (default theme).
- [ ] Toggle to light theme and confirm colors are still legible there too.
- [ ] No `#36812` (or similar numeric) tag pages appeared in **All Pages**.
- [ ] Reload Logseq: badges paint instantly from cache, with no skeleton flash.
- [ ] Disable networking, then reload: cached badges still render, dimmed.
- [ ] Run **Refresh PR states** from the command palette: badges re-fetch.
- [ ] Clear `localStorage` for the app, reload: skeletons appear, then resolve.

## Known follow-ups

None of these block use. All were found by review and deliberately deferred.

1. **Inline-layout CSS specificity** (cosmetic, most likely to be noticed).
   `div.macro:has(.pr-badge) > *` outranks `.pr-badge`, so in any Logseq build
   where our anchor is a *direct* child of `div.macro`, the badge loses
   `inline-flex` and the 0.35em gap between icon and title. If the icon and
   title look cramped, change that selector to `> *:not(.pr-badge)`.
2. **Rate-limit window drops the reference.** Inside the backoff window with a
   cold cache, the badge shows only "GitHub rate limit reached" with no ref and
   no link. `renderFallbackLink` already solves this for the other failure
   paths and applies here too.
3. **Per-alias GraphQL errors.** An alias nulled by a `FORBIDDEN` or
   `RATE_LIMITED` error is still reported as `not_found` ("may not exist, or
   the token may not have access"), which is right for auth and wrong for
   throttling. Correlating `errors[].path` would distinguish them.
4. **`onSettingsChanged` may fire per keystroke.** If Logseq's string input
   emits on each character, typing a token can send a short run of GraphQL
   requests with partial tokens, each 401ing. Debouncing ~1s, or comparing the
   new and previous settings, would remove it.
5. **`liveSlots` grows one entry per render pass.** Logseq mints a fresh slot
   id every render, so `redrawKey` fans `provideUI` calls out to slots that no
   longer exist. Harmless but wasteful over a long session; `Map<key,
   Set<slot>>` plus a liveness prune fixes it.
6. **Cache keys are case-sensitive.** `Avride/av#1` and `avride/av#1` occupy
   two cache entries and cost two fetches. Lowercasing in `refKey` fixes it.
7. **A throw mid-loop in `flush` does not re-queue its own batch.** Those refs
   wait for a re-render. Near-unreachable: `fetchPrs` converts every path to an
   outcome and `provideUI` is fire-and-forget.
8. **`cache.clear` is dead production code**, exercised only by its own test.

## Phase 2 is not done

The declarative home-manager install was deliberately not attempted. It needs
`darwin-rebuild switch` (a system-level change) and a commit to the dotfiles
repo, which already carries an unrelated uncommitted change.

It also cannot work as the plan describes it: the plan's module uses
`src = ../../../../logseq-pr-badges`, which escapes the flake root, so Nix
never copies the plugin source into the store. Use a flake input, `fetchGit`,
or commit `dist/` and drop the build step.
