# logseq-pr-badges

Renders GitHub pull request state inline in Logseq, the way GitHub does.

    {{pr avride/av#36812}}

→ a colored state octicon (open / draft / merged / closed) followed by the PR
title, linking to the pull request.

## Install

1. Enable Logseq's plugin system: Settings → Advanced → enable **Developer
   mode** and **Plug-in system**, then restart Logseq. Logseq's `{{renderer}}`
   macro branch is gated on the plugin system being on, so with it off nothing
   renders at all.
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
interval (default 15 minutes). `Refresh PR states` in the command palette re-fetches
every badge currently on screen, including merged and closed ones, and overwrites
the cache on success. It deliberately does not clear the cache first: a failed
fetch falls back to the last-known state rather than turning a working badge into
an error.

Titles are **not** written into your markdown, so Logseq search will not match a
block by pull request title.

If you see a "no GitHub token set" warning on a badge, pasting the token
automatically refreshes every badge currently on screen — no need to navigate
away and back. `Refresh PR states` in the command palette is still there if
you ever want to force a refresh yourself.

## Security

The badge link is rendered only for `https:` URLs — any other scheme has its
href stripped. Pull request titles are HTML-escaped before rendering.

## Development

    pnpm test        # unit tests for the four pure modules
    pnpm typecheck
    pnpm build
