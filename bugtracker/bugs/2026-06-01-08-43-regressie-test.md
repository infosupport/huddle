# Regressie test

**URL**: http://localhost:3000/
**Datum**: 1-6-2026, 08:43:03

We hebben nu een heel mooi portaal waarin we vanalles hebben afgeschermt.

Ik wil nu een regressie test suite.

Maak dit in volgende stappen.

1. Een lijst van alle features die we willen testen.
-> checkup of dit goed genoeg is naar mij
2. Een annalyse welke testsuite we best kunnen gebruiken ik wil 3 varianten met elk hun pros en cons
-> keuze gemaakt door mij
3. een plan hoe we alles gaan doen meer uitgewerkt
4. een team dat dit plan uitvoert.

## Voortgang — 1-6

- **Stap 1 (feature-lijst)** — opgesteld (domeinen A–I, afgeleid uit code + SECURITY.md
  T1–T11). Akkoord; afspraak: eerst de security-boundary (A/B/C), UI/terminal later.
- **Stap 2 (testsuite-keuze)** — 3 varianten voorgelegd; gekozen: **Variant 1 — TS-native**
  (Vitest + Playwright, met T1–T11 erin gevouwen).
- **Stap 3 (plan)** — uitgewerkt in [`TESTING.md`](../../TESTING.md): lagen, hoe te draaien,
  roadmap in prioriteitsvolgorde, en de DMZ-randvoorwaarden.
- **Stap 4 (uitvoeren)** — gestart met de hoogste prioriteit:
  - Vitest opgezet (`gateway/vitest.config.ts`, npm-scripts `test` / `test:watch` / `test:coverage`).
  - **Boundary C** (`test/source-ip-gate.test.ts`): 7 tests groen. Logica losgetrokken naar
    `src/net-gate.ts` (dependency-vrij, daardoor hermetisch testbaar).
  - **Boundary A** (`test/rules.test.ts`): `checkRule` op in-memory SQLite; skipt
    automatisch waar de native better-sqlite3-binding ontbreekt (DMZ), draait in image/CI.
  - `tsc --noEmit` + `vitest run` groen (8 passed, 8 skipped).

### Live boundary E2E toegevoegd — 1-6

`gateway/test/e2e/` (config `vitest.e2e.config.ts`, `helpers.ts`, `boundary.e2e.ts`,
`README.md`; script `npm run test:e2e`, opt-in `HUDDLE_E2E=1`). Spint via de echte
huddle-API een wegwerp-devcontainer op en exec't erin:
- firewall: niet-toegestaan domein → 403; na approval → 200;
- docker zonder grant → "denied by policy"; met grant → exit 0;
- HostConfig-escape `-v /:/host` + `--privileged` → "not permitted" (T11);
- `docker inspect huddle` (vreemde container) → geweigerd (T3);
- `GET huddle:3000/api/rules` → 403 (T4); `POST …/api/audit/sudo` → 200 (T5).
Draait alleen op een host met Docker + draaiende huddle. `tsc` clean.

Resterend (stap 4): unit/integration voor B docker-grants/audit/rules-API/spawn, de
E2E-uitbreidingen T1/T2/T8/T9, en de Playwright UI-laag. Zie roadmap in `TESTING.md`.

