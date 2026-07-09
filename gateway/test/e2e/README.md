# Live security-boundary E2E

Deze suite test de échte afscherming end-to-end: hij spint via de draaiende huddle
een **echte devcontainer** op, exec't erin, en controleert dat de firewall, de
docker-socket-gate en de huddle-self-traffic-regels daadwerkelijk afdwingen wat ze
moeten. Dit is de geautomatiseerde versie van `SECURITY.md` T1–T11.

> Draait **niet** mee in `npm test` (de snelle unit-run). Je hebt Docker + een
> draaiende huddle-stack nodig, dus het is opt-in.

## Voorwaarden

- Docker (Docker Desktop) draait op de host.
- De huddle-stack draait: `./huddle.ps1` (optie 4) → UI op `http://localhost:3000`.
- Een base-image bestaat (bv. `base-devimage-vscode`). Zo niet, dan bouwt huddle hem
  bij de eerste spawn — de eerste run duurt dan langer.
- Egress: de huddle-host moet `example.com` kunnen bereiken voor de "allow → 200"-stap.

## Draaien

```powershell
cd gateway
$env:HUDDLE_E2E = "1"
npm run test:e2e
```

Optionele overrides (env):

| Variabele | Default | Betekenis |
|-----------|---------|-----------|
| `HUDDLE_URL` | `http://localhost:3000` | admin-API van huddle |
| `HUDDLE_E2E_IMAGE` | `base-devimage-vscode` | base-image voor de wegwerp-container |
| `HUDDLE_E2E_IDE` | `vscode` | ide-type voor de spawn |
| `HUDDLE_E2E_NAME` | `devcontainer-e2e-boundary` | naam van de wegwerp-container |

De suite ruimt de container + testregels achteraf op (`afterAll`).

## Wat wordt getest

| Test | Bewijst |
|------|---------|
| firewall: niet-toegestaan domein → 403 | proxy blokkeert niet-allowlisted domeinen |
| firewall: na approval → 200 | een allow-regel opent het domein meteen |
| `docker ps` zonder grant → exit 0 | read-only ('always') acties werken zonder timer |
| mutatie zonder grant → `access timer` | tijdelijke acties vereisen een actieve timer |
| toggle `container.list` uit → `disabled` | een uit-geschakelde actie-toggle blokkeert, ook read-only |
| mutatie met grant → exit 0 | timer opent mutaties; eigen-volume delete bewijst labelinjectie |
| `-v /:/host` → `not permitted` (T11) | HostConfig-escape (host-path bind) geweigerd |
| `--privileged` → `not permitted` (T11) | privileged spawn geweigerd |
| `docker inspect huddle` → geweigerd (T3) | inspect van vreemde container geweigerd |
| `GET huddle:3000/api/rules` → 403 (T4) | management-API onbereikbaar vanuit container |
| `POST huddle:3000/api/audit/sudo` → 200 (T5) | sudo-audit ingest wél bereikbaar |
