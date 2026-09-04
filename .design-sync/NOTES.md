# design-sync notes — Huddle

## Shape: tokens-only, and why

Huddle's portal (`gateway/frontend`) is **Angular 21**; `docker-demo/frontend` is Angular 18.
There is no React anywhere in the repo and no Storybook. claude.ai/design renders React
(`non-storybook/SKILL.md`: *"Scope: React design systems … a non-React DS has nothing for the
claude.ai/design agent to build with"*), so the components cannot be synced.

What *is* syncable is the design language: `gateway/frontend/src/styles.css` (848 lines,
35 custom properties defined, 32 referenced, light + `[data-theme="dark"]`). The converter supports this as a
first-class **tokens-only** build (`source-kit.mjs` → `[ZERO_MATCH] … treating as tokens-only DS`,
`package-validate.mjs:367` `tokensOnly`). The user chose this scope knowingly on 2026-08-31,
after being told the agent will produce React mockups that Huddle's Angular portal cannot
consume directly.

## Build specifics

- `pkg` is `frontend`, which is in the converter's `GENERIC_PKG` set — hence the explicit
  `globalName: "Huddle"` (otherwise the namespace derives from the directory name).
- `entry` points at `gateway/frontend/.ds-entry.mjs`, a committed-as-ignored stub that exports
  nothing. It exists only so `PKG_DIR` resolves to `gateway/frontend` and esbuild has something to
  bundle. **Never point `entry` at `src/main.ts`** — that would bundle (and, on import, bootstrap)
  the whole Angular app into `_ds_bundle.js`.
- `cssEntry` is `src/styles.css`, the app's single global stylesheet. Tokens are `:root` custom
  properties inside that same file, not a separate tokens package, so `tokensPkg`/`tokensGlob`
  stay unset.

## Environment: Huddle DMZ blocks the converter's deps

This repo is developed inside a Huddle-firewalled devcontainer. Domains needed:

- `registry.npmjs.org` — **hard blocker**. `lib/source-kit.mjs` statically imports `ts-morph`, so
  `package-build.mjs` will not even load without it. (`esbuild` is already available locally via
  `gateway/frontend/node_modules`, courtesy of `@angular/build`.) Currently returns
  `403 x-huddle-blocked: 1`.
- `fonts.googleapis.com` + `fonts.gstatic.com` — the brand fonts are **DM Sans** and
  **Space Grotesk**, loaded by `src/index.html` via a Google Fonts `<link>`. There is no
  `@font-face` in the repo and no local `.woff2`, so validate will print `[FONT_MISSING]` unless
  the files can be fetched and shipped via `cfg.extraFonts`.

## Re-sync risks

- **The font decision is the fragile one.** If the woff2 files could not be fetched, every design
  built on this system renders DM Sans/Space Grotesk as a fallback and nothing downstream catches
  it. Re-check `fonts/` is populated on each sync.
- **`.ds-entry.mjs` is gitignored** (it is build scaffolding, not source). A fresh clone must
  recreate it before the converter runs, or `PKG_DIR` resolution fails.
- **The stylesheet is app CSS, not a component library.** Class names in `styles.css` are Huddle's
  own page/layout classes; if the portal is restyled or split up, the conventions header will name
  classes that no longer exist. Re-run the header's validation pass against the fresh build every
  sync.
- If the portal ever gains a React component package, this whole shape changes — drop the entry
  stub, drop tokens-only, and re-detect.

## Blocked: the upload never ran (2026-08-31)

The bundle is complete and verified, but nothing was uploaded — there is no Claude Design project
for Huddle yet, and `.design-sync/config.json` therefore holds no `projectId`. A future sync starts
as a first-time import, not a re-sync.

`DesignSync` fails every call with *"needs design-system authorization. Run /design-login …"*, and
`/design-login` reports success each time. Neither is the real cause. Diagnosis, in order:

1. `claude.ai`, `api.claude.ai` and `console.anthropic.com` were blocked by the firewall
   (`x-huddle-blocked: 1`). The user allowlisted them — `claude.ai` now answers 302. The error
   did not change.
2. The actual cause is Huddle's own token management. A devcontainer never holds the real OAuth
   token: `token-exchange.ts` hands it a `huddle_tok_<hex>` placeholder and the gateway swaps in
   the real token on the way out. That swap is gated on a single hostname in `proxy.ts`
   (`hostname === 'api.anthropic.com'`). `DesignSync` talks to `claude.ai`, which falls outside the
   gate, so the placeholder reaches claude.ai unrewritten and is rejected.

Widening that gate to an allowlist would make this work and would not weaken the security property
(the real token still never enters the container). It was deliberately NOT done: the owner considers
credential handling a separate design that needs generalizing rather than a per-host patch. Until
that lands, **this design system can only be uploaded from outside a Huddle devcontainer**, where a
real claude.ai credential exists. Everything up to the upload is reproducible from this repo:

    node .ds-sync/resync.mjs --config .design-sync/config.json \
      --node-modules .ds-sync/node_modules --out ./ds-bundle --no-render-check

Unverified: that claude.ai's design endpoints accept the same OAuth access token as
`api.anthropic.com`. Likely (one credential file), but only a working upload proves it.
