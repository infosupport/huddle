# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## What Huddle is

Huddle is a security gateway that shields devcontainers from the external network through a per-domain firewall. Every devcontainer's outbound traffic is forced through Huddle; only allowlisted domains get through. Huddle also proxies the Docker socket (fine-grained, per-container permissions instead of a raw socket mount) and grants ephemeral, time-boxed sudo instead of standing admin credentials.

## Repository layout

- `gateway/` — the Huddle application: Fastify API + Angular 21 UI + proxy, all TypeScript. This is where nearly all backend work happens.
  - `gateway/src/` — backend source, compiled by `tsc` to `gateway/dist/`.
  - `gateway/frontend/` — Angular SPA (standalone components, signals), built by Angular CLI into `gateway/dist/ui/browser` and served by the same Fastify instance.
  - `gateway/extensions/aikido/` — a built-in runtime extension (see README "Extensions" section for the extension API).
  - `gateway/test/` — vitest unit tests (`test/**/*.test.ts`) plus a separate live e2e suite (`test/e2e/**/*.e2e.ts`, see below).
- `cli/` — the cross-platform `huddle` CLI (`cli/src/index.ts`), a thin HTTP client against Huddle Node's API plus the `huddle init`/`huddle sbx` orchestration logic.
- `packages/huddle-node-*` — per-platform published packages for the standalone Huddle Node executable (darwin-arm64/x64, linux-x64, win32-x64).
- `base-devimage*/` — Dockerfiles for the devcontainer base images (VS Code, IntelliJ, Rider).
- `docs/` — ADRs and design docs; read these before touching the areas they cover (see "Key docs" below).
- `docker-demo/` — a sample frontend+backend app for exercising Huddle's firewall.

## Commands

Run from repo root unless noted.

```bash
npm install              # installs deps for gateway + cli (postinstall runs scripts/install-subprojects.mjs)
npm run build            # builds gateway (Angular UI, then tsc) — npm --prefix gateway run build
npm run cli:build        # tsc build of the CLI
npm run cli:typecheck    # tsc --noEmit for the CLI
npm start                # runs Huddle Node locally: npm --prefix gateway start (node dist/index.js)
```

Testing (gateway):

```bash
npm --prefix gateway test              # vitest unit tests — fast, in-memory SQLite (DB_PATH=:memory:), no Docker required
npm --prefix gateway run test:watch
npm --prefix gateway run test:coverage
npm --prefix gateway run test:e2e      # LIVE e2e suite — spins up real devcontainers via a running huddle stack; needs Docker + huddle running. See gateway/test/e2e/README.md
```

Run a single gateway test file or test case with vitest directly:

```bash
npx vitest run test/rules.test.ts --config gateway/vitest.config.ts
npx vitest run -t "test name substring" --config gateway/vitest.config.ts
```

Testing (CLI): `npm --prefix cli test` (vitest, `cli/test/*.test.ts`).

Local end-to-end dev loop against a real container image:

```bash
npm run local:prepare     # podman build ./gateway -t huddle-debug && cd cli && npm install && npm run build && npm link
```

There is no separate lint script; formatting is Prettier (`npx prettier --write .` within the relevant package — see CONTRIBUTING.md). TypeScript is `strict: true` in both `gateway/tsconfig.json` and `cli/tsconfig.json`; keep changes type-safe (no new untyped `any`).

## Architecture

Huddle runs as **two processes**, not one — this is the single most important thing to know before changing backend code:

- **Huddle Node** — the control plane, runs directly on the developer's host machine (not in Docker). Owns the SQLite database, the REST API + Angular UI (port 24842, loopback-only), Docker orchestration, sbx sandbox orchestration, extensions, and config (`~/.huddle/config.json`).
- **huddle-gateway** — the data/enforcement plane, runs *inside* Docker. Holds no database, no Docker socket, no API, no portal. It caches the firewall policy in memory (pushed from Node over a control channel on port 24843), decides allow/deny locally so Node is never in the hot path of a request, and reports decisions back afterwards. If Node is down, the gateway keeps enforcing the last policy it received; before the first policy ever arrives, it denies everything (fail-closed).

Both halves are built from the *same* `gateway/` source tree and the same compiled `dist/`; which half a process becomes is decided at startup by `HUDDLE_ROLE` (`node` or `gateway`), resolved once at import time in `gateway/src/runtime-env.ts`. Read that file's header comment before adding new config — it's the single place responsible for every host/gateway path, port, and bind-address difference (previously scattered literals across `db.ts`, `auth.ts`, `api.ts`, `docker.ts`, `terminal.ts`, `socket-proxy.ts`, `tls-ca.ts`). `gateway/src/index.ts` picks a role and dynamically imports either `boot-node.ts` or `boot-gateway.ts` — the imports are dynamic specifically so that, e.g., the gateway process never touches `db.ts` (which opens a database at import time) even though it shares a dependency graph with Node.

Full narrative and the "why" behind the split: **`docs/ADR-huddle-node-split.md`**. Do not assume anything about "the gateway" without checking whether a given module is Node-side or gateway-side — get this wrong and you'll design something that can't work across the process boundary (e.g. code in the gateway trying to read the database directly).

### Data plane (firewall enforcement)

```
devcontainer --(iptables DNAT, --internal network)--> huddle-gateway:80 --> internet
```

Two enforcement layers: `devcontainer-net` is Docker `--internal` (no route off the host at all), and inside each devcontainer, iptables DNATs all outbound :80 traffic to the gateway and drops everything else. Rule evaluation (`gateway/src/rules.ts`, `rule-match.ts`) is per-container with global fallback. HTTPS is CONNECT-tunneled (not intercepted); HTTP is fully logged (`gateway/src/proxy.ts`, `db.ts` network log).

### Docker socket proxy

Each devcontainer gets its own Unix socket at `/tmp/dc-sockets/<name>/docker.sock`, mounted into the container. The socket *file* is created by the **gateway** (it's the half actually on the Docker engine host — relevant on Docker Desktop/Rancher/`podman machine` where the engine lives in a VM), but the filtering logic runs on **Huddle Node**; the gateway tunnels every connection to Node's control channel as an HTTP Upgrade and forwards bytes without deciding anything itself. See `gateway/src/socket-proxy.ts` (filter), `gateway/src/socket-relay*.ts` (gateway-side tunnel), `gateway/src/docker-actions.ts` (the action catalog: temporary time-boxed grants vs. always-allowed read-only actions, all off by default).

### sbx (Docker Sandboxes / microVM) mode

An alternate, parallel workspace runtime to devcontainers, using Docker Sandboxes microVMs instead of containers. This is **actively under design/implementation** — read `docs/ADR-workspace-runtime-abstraction.md` and `docs/ADR-sbx-identity.md` before touching `gateway/src/sbx.ts`, `gateway/src/sandbox/`, or `cli/src/sbx*.ts`. Key points those ADRs establish:
- The sbx daemon (not Huddle) is the only party that can distinguish one sandbox from another at the network layer — Huddle can prove "this is our sandbox fleet" but not *which* sandbox, unless a per-sandbox credential is baked into the upstream-proxy URL at sandbox-create time (`Proxy-Authorization`, minted by Huddle Node).
- Per-sandbox firewall enforcement is therefore *delegated* to sbx's own policy engine; Huddle's DB stays the source of truth and is synced into sbx one-way (Huddle → sbx, never the reverse).
- Huddle remains the upstream proxy for audit and TLS termination, and still enforces at fleet level.
- The current branch (`feat/sbx-sandboxes-rebased`) is mid-implementation of this — check `docs/ADR-huddle-node-split.md`'s step table for what's landed vs. pending before assuming a piece exists.

### Admin access (ephemeral sudo)

No standing admin credentials: the `noot` user is created locked. Granting admin access (`gateway/src/sudo-grant.ts`) sets a fresh random password via `chpasswd` over stdin (never a shell arg), shows it exactly once in the UI, and never stores it. A sweeper (runs every 30s on the gateway, since locking must happen *inside* the container) re-locks `noot` on expiry.

### Frontend

Angular 21, standalone components + signals, in `gateway/frontend/src/app/`. Structure: `pages/` (one dir per route: dashboard, containers, firewall, docker-access, audit, sandboxes, extensions, settings...), `shared/components/` (reusable UI incl. the central `<app-icon>` SVG registry and the pie-menu used for approve/snooze/reject actions), `shared/modals/`, `core/models/` (Rule, Container, Grant, AuditLog types), `core/services/` (ApiService, StateService, ModalService). State updates arrive over WebSocket as a single `{ type: "reload" }` push on any state-mutating API call — the frontend re-fetches rather than trusting a diff.

### Extensions

Runtime-loaded `.zip` plugins uploaded through the UI, no restart needed (`gateway/src/extensions/`). Each has `manifest.json` + `index.js` (CommonJS backend, `register(ctx)`) + optional `frontend/*.js` (Web Components). `ctx` gives routes under `/api/ext/<id>/`, settings storage, `ctx.fetch` (goes through Huddle's own proxy and firewall, logged as `ext:<id>`), container exec, event bus, and direct DB access. See README "Extensions" section for the full API and the built-in `gateway/extensions/aikido/` example.

## Key docs to read before changing related code

- `docs/ADR-huddle-node-split.md` — the Node/gateway process split; read before touching `runtime-env.ts`, `boot-node.ts`, `boot-gateway.ts`, or anything crossing the control channel.
- `docs/ADR-workspace-runtime-abstraction.md` — the planned `WorkspaceRuntime` abstraction unifying container and sbx workspaces; read before adding a workspace-lifecycle feature that should work for both.
- `docs/ADR-sbx-identity.md` — how a Docker Sandbox is identified at the gateway proxy (per-sandbox `Proxy-Authorization` credential minted at create time); read before touching sbx proxy/identity code.
- `docs/security/socket-proxy-parser-hardening.md` — hardening notes for the Docker socket proxy's request parser.
- `README.md` — architecture diagram, full feature list, API reference table, troubleshooting table. Check here first for anything user-facing (CLI commands, firewall/Docker-proxy behavior, extension API) before re-deriving it from source.

## Conventions

- Commit messages: Conventional Commits (`type(scope): summary`, imperative mood) — see CONTRIBUTING.md. Branch names: `feat/`, `fix/`, `docs/`, `chore/` prefixes; `main` is trunk, no direct commits.
- This is a security tool: never log secrets/tokens/credentials or full request bodies containing them; prefer fail-closed behavior for anything access-gating (mirrors the gateway's own "no policy yet = deny" default).
- Comments in this codebase tend to explain *why* a non-obvious constraint exists (e.g. why a directory is mounted instead of a file, why an import is dynamic) rather than restate the code — match that style; it's frequently load-bearing for understanding cross-process constraints that aren't visible from a single file.
