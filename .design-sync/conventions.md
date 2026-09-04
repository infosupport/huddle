# Huddle design system — how to build with it

**This is a tokens-only design system: there are no React components in the bundle.**
`window.Huddle` is intentionally empty. Huddle's real UI is Angular; only the design
language (tokens, fonts, and the portal's own class vocabulary) is synced. Build
screens with plain HTML/JSX elements and the class names below — never try to import
or call `window.Huddle.<Something>`.

## Setup

Nothing to wrap or provide. `styles.css` pulls in the fonts (`DM Sans` for body/UI,
`Space Grotesk` for numeric display) and the full portal stylesheet, so markup is
styled the moment it carries the right classes.

Theme is an attribute on the root element, not a provider:

- light (default): `<html>` with no attribute
- dark: `<html data-theme="dark">`

Every token has a value in both themes, so a screen written with tokens works in both
without extra work. Page shell: `.app` (grid: sidebar + main) > `.sidebar` + `.main`
(`.topbar` then `.content`).

## Styling idiom

Use the existing classes first; reach for `var(--token)` only for one-off spacing,
colours, and custom blocks. Never hard-code a hex colour — the dark theme redefines
the tokens, and a literal colour breaks it.

**Colour / surface tokens:** `--bg`, `--bg-sidebar`, `--surface`, `--surface-2`,
`--surface-hover`, `--border`, `--border-strong`, `--text`, `--text-muted`,
`--text-dim`, `--table-head`.
**Brand:** `--accent`, `--accent-strong`, `--accent-soft`, `--aurora-1`, `--aurora-2`.
**Semantic pairs** (solid + tinted background): `--success`/`--success-soft`,
`--warning`/`--warning-soft`, `--danger`/`--danger-soft`, `--info`/`--info-soft`.
**Shape & depth:** `--radius`, `--radius-lg`, `--radius-sm`, `--shadow-card`,
`--shadow-pop`, `--sidebar-w`.
**Illustrations** (theme-aware `url()`): `--asset-logo`, `--asset-igloo`,
`--asset-sunset`, `--asset-aurora`, `--asset-folder`.

**Class vocabulary** (BEM-ish; `__` = element, `--` = modifier):

| Concern | Classes |
|---|---|
| Layout | `.app`, `.sidebar`, `.sidebar__logo`, `.sidebar__footer`, `.main`, `.topbar`, `.topbar__title`, `.content` |
| Nav | `.nav`, `.nav__section`, `.nav__item`, `.nav__item--active` |
| Grids | `.grid-2`, `.grid-3`, `.dashboard-grid`, `.col-span-1` … `.col-span-4` |
| Cards | `.card`, `.card__head`, `.card__title`, `.link` |
| KPIs | `.kpis`, `.kpi`, `.kpi__head`, `.kpi__label`, `.kpi__value`, `.kpi__icon`, `.kpi__foot` |
| Buttons | `.btn` + `.btn-primary`, `.btn-ghost`, `.btn-sm`, `.btn-delete`, `.btn-allow`, `.btn-deny` |
| Status | `.status--running`, `.status--stopped`, `.status--rogue`; `.dot` + `--ok/--warn/--err` |
| Labels | `.pill` + `--allow/--deny/--pending/--active/--expires`; `.badge-pill` + `.green/.yellow/.red/.muted` |
| Tables | `.table` / `.data-table` (plain `<thead>`/`<tbody>`; `tr.clickable` for row links) |
| Activity | `.feed`, `.feed-item`, `.feed-item__icon`, `.feed-item__body`, `.feed-item__title`, `.feed-item__sub`, `.feed-item__time` |
| Forms | `.form-group`, `.form-label`, `.form-input`, `.form-select`, `.form-error`, `.form-status` |
| Modals | `.modal`, `.modal-box` (+ `--narrow`/`--wide`), `.modal-header`, `.modal-body`, `.modal-footer`, `.modal-close` |
| Text | `.muted` |

Huddle is a security gateway console: allow/deny, pending grants, and running/stopped
containers are the recurring states, which is why the semantic colours come in
allow-green / deny-red / pending-amber triples. Stay in that mapping.

## Where the truth lives

`_ds_bundle.css` is the portal's real stylesheet, compiled from
`gateway/frontend/src/styles.css` in the Huddle repo. It is the single source for
every class and token above; when in doubt, read it rather than inventing a name.

## Idiomatic example

```jsx
<section className="card">
  <div className="card__head">
    <h2 className="card__title">Firewall rules</h2>
    <a className="link">Manage</a>
  </div>
  <table className="data-table">
    <thead><tr><th>Domain</th><th>Status</th><th /></tr></thead>
    <tbody>
      <tr className="clickable">
        <td>registry.npmjs.org</td>
        <td><span className="pill pill--allow">allowed</span></td>
        <td style={{ textAlign: 'right' }}>
          <button className="btn btn-sm btn-deny">Deny</button>
        </td>
      </tr>
      <tr className="clickable">
        <td>dev.azure.com</td>
        <td><span className="pill pill--pending">pending</span></td>
        <td style={{ textAlign: 'right' }}>
          <button className="btn btn-sm btn-allow">Allow</button>
        </td>
      </tr>
    </tbody>
  </table>
</section>
```
