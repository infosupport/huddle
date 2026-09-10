# Workshop site

The Huddle Workshop pages, published to GitHub Pages by
[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) on every push to
`main` that touches this directory (or via **Run workflow** in the Actions tab).

```
site/
├── index.html                          the workshop overview
├── workshop/
│   ├── part-1-get-it-working.html      deep dive — skeleton
│   ├── part-2-experiment-98.html       deep dive — skeleton
│   └── part-3-experiment-109.html      deep dive — skeleton
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

## Still to write

Each deep-dive page carries the content the design already specified for its
part, plus `TO BE WRITTEN` notes marking the sections the in-depth walkthroughs
still need. Those notes are visible on the published page on purpose — they say
what is missing rather than pretending the page is finished.
