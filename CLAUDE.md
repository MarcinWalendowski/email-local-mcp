# CLAUDE.md — Email Local MCP

Guidance for Claude Code working in this repo. This is a **public, released**
project (npm, GitHub Releases, a Homebrew tap, a published landing page), so the
workspace-level "pre-launch, no backward-compatibility burden" exception in the
<!-- name-check: legacy-ok — the workspace file's real path. -->
workspace root `CLAUDE.md` (`~/loki-labs/CLAUDE.md`)
<!-- name-check: /legacy-ok -->
does **not** apply here. Real people have this installed.

## The marketing page is part of the product, not a separate thing

**Every change that alters what the product does, or what is true about it, must
update the landing page in the same session as the code.** Not "later", not a
follow-up task. If the page still describes the previous behaviour after your
commit, the change is not finished.

The page source is `site/index.html` **on `main`**, and `tools/publish-site`
pushes it to the `gh-pages` branch. It used to live *only* on `gh-pages`, which
is the structural reason it drifted: nothing in the tree anyone edits ever
pointed at it, so no amount of good intentions kept it current. It is in `main`
now precisely so that a change to the code and a change to the page happen in
one working tree, in one diff, under one review.

What counts as "alters what is true about it":

- A new capability, auth mode, provider, tool, or platform.
- A change to how mail is handled, where credentials live, or what leaves the
  machine. **These are load-bearing security claims**, and the page states them
  as absolutes. An absolute claim is either true or it is a lie; there is no
  "mostly".
- Install instructions, supported OSes, prerequisites, pricing, licence.
- Anything the README's own security section says, because the page and the
  README must never disagree. When you edit one, diff the other.

What does not: internal refactors, test-only changes, comment edits, and
anything a user could not observe.

**Verify by grep, not by intention.** After editing, grep the page for the claim
you invalidated and prove the old wording is gone — the same negative-control
rule `tools/name-check` exists to enforce for the old product name. A copy change
that "looks updated" is the exact failure mode this rule was written after.

Run `tools/site-check` before committing. It fails when the page asserts
something the code contradicts.

## Naming is enforced, not remembered

<!-- name-check: legacy-ok — names the banned tokens in order to ban them. -->
`tools/name-check` fails the build on the retired product name (`anymail`) and
the retired org name (`lokilabs` / `loki-labs`).
<!-- name-check: /legacy-ok -->
This project is published under
its author's name: npm maintainer `mwalendowski`, `github.com/MarcinWalendowski`,
a personal Homebrew tap, bundle id `pl.marcinwalendowski.EmailLocalMCP`, and
`Copyright (c) 2026 Marcin Walendowski`.

Genuinely historical references (a changelog entry, a spec recording what was
true then) are fenced per-region, never per-file:

```
<!-- name-check: legacy-ok -->  ...  <!-- name-check: /legacy-ok -->
```

An unclosed fence is an error, because otherwise the way to silence the check
forever is to open one and never close it.

## Gates

```bash
npm run typecheck     # tsc across all three tsconfigs
npm test              # node --test
tools/name-check      # retired names
tools/site-check      # the landing page vs the code
```

All four must be green before a commit. Ask before building the macOS app or
cutting a release — those are not part of the normal gate loop.

## Releasing

See `RELEASING.md`. The bundle identifier is an app's permanent identity: Sparkle
keys auto-update on it, so changing it strands every installed copy on its
current version until the user reinstalls by hand. Do not change it casually, and
when it does change, say so loudly in `CHANGELOG.md` and list both old and new
paths in the Homebrew cask's `zap`.
