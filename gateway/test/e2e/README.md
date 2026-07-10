# Live security-boundary E2E

This suite tests the real isolation end-to-end: through the running huddle it spins
up a **real devcontainer**, execs into it, and verifies that the firewall, the
docker-socket gate, and the huddle self-traffic rules actually enforce what they
should. This is the automated version of `SECURITY.md` T1–T11.

> Does **not** run as part of `npm test` (the fast unit run). You need Docker + a
> running huddle stack, so it is opt-in.

## Prerequisites

- Docker (Docker Desktop) is running on the host.
- The huddle stack is running: `./huddle.ps1` (option 4) → UI at `http://localhost:3000`.
- A base image exists (e.g. `base-devimage-vscode`). If not, huddle builds it on
  the first spawn — the first run then takes longer.
- Egress: the huddle host must be able to reach `example.com` for the "allow → 200" step.

## Running

```powershell
cd gateway
$env:HUDDLE_E2E = "1"
npm run test:e2e
```

Optional overrides (env):

| Variable | Default | Meaning |
|----------|---------|---------|
| `HUDDLE_URL` | `http://localhost:3000` | huddle's admin API |
| `HUDDLE_E2E_IMAGE` | `base-devimage-vscode` | base image for the throwaway container |
| `HUDDLE_E2E_IDE` | `vscode` | ide type for the spawn |
| `HUDDLE_E2E_NAME` | `devcontainer-e2e-boundary` | name of the throwaway container |

The suite cleans up the container + test rules afterwards (`afterAll`).

## What is tested

| Test | Proves |
|------|--------|
| firewall: disallowed domain → 403 | proxy blocks non-allowlisted domains |
| firewall: after approval → 200 | an allow rule opens the domain immediately |
| fresh container → `disabled` | secure by default: all actions are off, including read-only |
| toggle on → `docker ps` exit 0 | read-only ('always') works without a timer once the toggle is on |
| mutation with toggle, without grant → `access timer` | temporary actions additionally require an active timer |
| mutation with toggle and grant → exit 0 | timer + toggle opens mutations; own-volume delete proves label injection |
| `-v /:/host` → `not permitted` (T11) | HostConfig escape (host-path bind) rejected |
| `--privileged` → `not permitted` (T11) | privileged spawn rejected |
| `docker inspect huddle` → rejected (T3) | inspecting a foreign container rejected |
| `GET huddle:3000/api/rules` → 403 (T4) | management API unreachable from the container |
| `POST huddle:3000/api/audit/sudo` → 200 (T5) | sudo-audit ingest is reachable |
