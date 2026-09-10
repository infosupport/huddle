# Workshop site

The Huddle Workshop pages, published to GitHub Pages by
[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) on every push to
`main` that touches this directory (or via **Run workflow** in the Actions tab).

```
site/
├── index.html                          the workshop overview
├── workshop/
│   ├── part-1-get-it-working.html      architecture + empty containers
│   ├── part-2-experiment-98.html       firewall rule export/import (PR #98)
│   └── part-3-experiment-109.html      sandboxes vs devcontainers (PR #109)
└── assets/
    ├── site.css                        design tokens + shared components
    ├── copy.js                         copy-to-clipboard for command blocks
    ├── hero-igloo-signs.png
    └── footer-penguins.png
```

Plain static HTML — no build step. Open `index.html` in a browser, or serve the
directory (`python3 -m http.server` from here) to click through with the
relative paths intact.

## Where the design comes from

`index.html` is a conversion of `Huddle Workshop.dc.html` from the Claude Design
project `a437034a-6f90-45cf-a088-bd2c0aaacda5`. The canvas constructs were
resolved to static equivalents:

| In the design | Here |
| --- | --- |
| `<image-slot src=…>` | `<img>` with `object-fit: cover` |
| `{{ cmd98 }}` / `{{ cmd109 }}` | the literal `huddle experiment use 98` / `109` |
| `onClick="{{ copy98 }}"` | `.copy-btn[data-copy]` + `assets/copy.js` |
| `<sc-if value="{{ findings }}">` | inlined (the prop defaulted to `true`) |
| `style-hover="…"` | real `:hover` rules in `assets/site.css` |

The overview keeps the design's inline styles so it stays easy to diff against
that source when the design changes. The deep-dive pages use the classes and
tokens in `assets/site.css` instead.

The export also ships an `_ds/` "Industry" design system. It does not apply
here — the workshop design deliberately departs from it (Plus Jakarta Sans,
rounded cards, orange-on-steel-blue rather than Barlow wireframe blueprints), so
these pages follow the design file, not that kit.

## Where the deep-dive content comes from

The three walkthroughs were written from the code, not from the design's summary
of it, so they go stale the way code does. If you change any of this, check the
pages:

| Page | Written from |
| --- | --- |
| Part 1 | `cli/src/init.ts`, `cli/src/start.ts`, `cli/src/runtime.ts`, `gateway/src/docker.ts`, the portal's start-container modal |
| Part 2 | PR #98 (`pull/98/head`) — `cli/src/firewall.ts`, `gateway/src/firewall-group-*.ts`, `gateway/src/firewall-rules-folder.ts`, `examples/firewall-rules/` |
| Part 3 | PR #109 (`pull/109/head`) — `gateway/src/sbx*.ts`, `gateway/src/sandbox/`, `cli/src/sbx.ts`, `gateway/src/runtime-env.ts`, the ADRs under `docs/` |

Parts 2 and 3 document **pull requests, not releases**. When either merges or
moves on, re-read the branch before trusting the page. Read the PR without
switching your working branch:

```bash
git fetch origin pull/98/head:refs/remotes/pr/98
git show pr/98:cli/src/firewall.ts
```

(GitHub's API is blocked from inside a Huddle devcontainer, so `gh pr view`
returns a 403 there while `git fetch` works.)

## `TO BE WRITTEN` notes

Some sections are marked `TO BE WRITTEN` on the published page, on purpose:
they need someone's notes from actually running the workshop — the tested
platform matrix, the walkthrough for bringing your own project in, the workshop
choreography for part 2, and an end-to-end sandbox run for part 3. Saying so
beats guessing, and beats a page that looks finished when it isn't.
