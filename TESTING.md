# Huddle — Regressie-test suite

Status: **in opbouw**. Dit document is het uitgewerkte plan (ticket *Regressie test*,
1-6-2026) plus hoe je de bestaande tests draait.

Gekozen aanpak (na afstemming): **Variant 1 — TS-native**: [Vitest](https://vitest.dev)
voor backend unit/integration + [Playwright](https://playwright.dev) voor UI-E2E én de
HTTP-niveau security-boundary-checks. De bestaande handmatige T1–T11 uit `SECURITY.md`
worden hierin gevouwen i.p.v. een aparte tweede stack.

Prioriteit (afgesproken): eerst de **security-boundary** (A firewall, B docker-grants,
C source-IP gate), daarna functioneel/UI (D–I).

## Lagen

| Laag | Tool | Wat | Heeft nodig |
|------|------|-----|-------------|
| **Unit / pure logica** | Vitest | rules-engine, source-IP/CIDR-gate, helpers | niets (snel, hermetisch) |
| **Integration (backend)** | Vitest + Fastify `inject` | API-routes, validatie, source-IP whitelist, audit-ingest | in-memory SQLite |
| **E2E (UI + boundary)** | Playwright | UI-flows + live HTTP/firewall/socket-asserties (T1–T11) | draaiende huddle-stack + wegwerp-devcontainer |

## Draaien

Backend (Vitest), vanuit `gateway/`:

```bash
npm test            # eenmalig
npm run test:watch  # watch-modus
npm run test:coverage
```

> **better-sqlite3 is native.** In een DMZ-devcontainer zonder gebouwde binding
> (`nodejs.org` geblokkeerd → `node-gyp` kan geen headers ophalen) **skippen** de
> SQLite-tests automatisch (`describe.skipIf`). Ze draaien volledig in de huddle-image
> of CI, waar de binding al gebouwd is. Wil je ze hier draaien: sta `nodejs.org` toe in
> de Huddle-UI en run `npm rebuild better-sqlite3`.

## Wat er al staat (stap 4 — gestart)

**Unit / integration (Vitest, `npm test`)**

- `gateway/vitest.config.ts` — node-env, `DB_PATH=:memory:`, v8-coverage.
- `gateway/test/source-ip-gate.test.ts` — **boundary C (unit)**: `ipv4ToInt`,
  `cidrToRange`, `isDevcontainerSource` (subnet-match, IPv4-mapped IPv6, ongeldige
  input). Logica losgetrokken naar `gateway/src/net-gate.ts` (dependency-vrij).
- `gateway/test/rules.test.ts` — **boundary A (unit)**: `checkRule` (allow/deny/
  requested, per-container > globaal, temp-allow expiry) op in-memory SQLite.

**Live boundary E2E (Vitest, `npm run test:e2e`, opt-in `HUDDLE_E2E=1`)**

- `gateway/test/e2e/` (`vitest.e2e.config.ts`, `helpers.ts`, `boundary.e2e.ts`,
  `README.md`). Spint via de echte huddle-stack een wegwerp-devcontainer op en exec't
  erin. Dekt: firewall blokkeren→toestaan, docker geweigerd-zonder-grant→toegestaan-
  met-grant, HostConfig-escape (`-v /:/host`, `--privileged`) geweigerd (T11),
  inspect-vreemde-container geweigerd (T3), management-API 403 (T4), sudo-audit 200 (T5).
  Draait **alleen op een host met Docker + draaiende huddle** — zie `test/e2e/README.md`.

> **Cross-platform node_modules.** `gateway/node_modules` op de gedeelde volume bevat
> native modules (better-sqlite3, vitest's rolldown) voor één OS tegelijk. Na een
> `npm install` op Windows draaien de tests op de host; in de Linux-devcontainer moet
> je dan opnieuw `npm install` doen (of andersom). Draai de tests op het OS waar je
> laatst installeerde.

## Roadmap (stap 4 — resterend)

Volgorde = afgesproken prioriteit.

1. **Boundary B — docker-grants** (Vitest+inject): `PUT/DELETE /api/authz/grants/:c`
   (1–120 min validatie), grant-expiry, audit-entry bij grant/revoke.
2. **Boundary C — gate als integratie** (Vitest+inject): `onRequest`-hook met een
   gesimuleerde devcontainer-bron → 403 op alles behalve `POST /api/audit/sudo` (T4/T5/T7).
3. **Audit (F)**: `logAudit` + query-filters (container/domain/action/limit/offset);
   sudo-ingest attributie i.p.v. spoofbare body (T6).
4. **Rules-API (A)**: `PUT /api/rules/:id` status-transities + expiry; `DELETE`.
5. **Spawn/lifecycle (D)**: `getBaseImageName`, `isIdeName` (incl. `vscode`), StartParams-
   afhandeling van `empty`, leaf/workspace-afleiding — met Docker-calls gemockt.
6. **Live boundary E2E** — ✅ **gedaan** (`test/e2e/boundary.e2e.ts`): firewall block→allow,
   docker grant-gating, HostConfig-escape (T11), foreign-inspect (T3), mgmt-API 403 (T4),
   sudo-audit 200 (T5). Nog uit te breiden: T1/T2 (socket-mount + `ps`-filtering detail),
   T8 (HTTPS CONNECT naar huddle geweigerd), T9 (spawn forceert netwerk/label).
7. **E2E (Playwright, UI)**: dashboard/containers/detail-tabs render; firewall- en
   docker-access-flows via de UI; bug-button → `/api/bugs`. (Browser-download vergt
   CDN-toegang of een CI/host-cache.)

### Bekende randvoorwaarden in de DMZ

- **SQLite-tests**: zie kader hierboven (`nodejs.org`).
- **Playwright-browsers**: `npx playwright install` haalt browsers van een CDN; sta die
  toe in de Huddle-UI óf draai de E2E-laag in CI/host waar dat al gecached is.
