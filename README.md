# Huddle

<p align="center">
  <a href="LICENSE"><img alt="License: GPL v3" src="https://img.shields.io/badge/License-GPLv3-blue.svg"></a>
  <a href="CONTRIBUTING.md"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg"></a>
  <img alt="Provided as-is, no SLA" src="https://img.shields.io/badge/support-AS--IS%2C%20no%20SLA-lightgrey.svg">
</p>

## What is Huddle?

Huddle is a security gateway that shields devcontainers from the external network through a per-domain firewall. Every devcontainer runs in a DMZ: all outbound traffic is forced through Huddle, and only domains on the allowlist are let through. Operators manage firewall rules, Docker access, and network logs through a central web UI.

Your IDE (JetBrains or VS Code) feels normal, but code, tools, and AI run in a shielded environment. Execution is isolated; the portal stays in control of what goes in and out.

<p align="center">
  <img src="docs/images/huddle-portal.png" alt="Developers working through Huddle in shielded devcontainers" width="820">
</p>

## Why Huddle?

Huddle addresses two major risks of modern, AI-assisted development:

- **Developing safely *with* AI** — AI should be able to help, but not modify your system unchecked or exfiltrate data.
- **Developing safely *against* AI-amplified attacks** — supply-chain attacks are getting smarter, faster, and multi-stage. Huddle intercepts outbound traffic and blocks anything that isn't explicitly allowed.

<p align="center">
  <img src="docs/images/huddle-risks.png" alt="Developing safely with AI and against supply-chain attacks" width="820">
</p>

## Architecture

```
Devcontainer
  └─ HTTP/HTTPS traffic → Huddle proxy (port 80)
       └─ rules engine → allow / deny / request
  └─ Docker socket → /tmp/dc-sockets/<name>/docker.sock (per-container proxy)
       └─ label isolation + time-limited grant check

Browser
  └─ Angular SPA (port 3000) + WebSocket live push
       └─ Fastify REST API (/api/...)
```

Two servers run in the same process:

| Server | Port | Purpose |
|--------|------|---------|
| HTTP proxy | 80 | Forward/intercept all outbound container traffic |
| API + UI | 3000 | REST API, Angular frontend, WebSocket push |

<p align="center">
  <img src="docs/images/huddle-gateway.png" alt="Huddle gateway: traffic, Docker access, and logs flow through the DMZ under control" width="820">
</p>

### Three security principles

| Principle | What it means |
|-----------|---------------|
| **No direct internet** | Traffic flows through the Huddle Gateway with firewall approvals — no container talks to the external network directly. |
| **Docker proxy socket** | No full Docker socket, but controlled Docker actions through a per-container proxy with a label policy. |
| **No root user** | A safer default user; `sudo` is only possible in a controlled way through Huddle. |

---

## Features

### Firewall
- Per-container and global allow/deny rules stored in SQLite
- Rules can be permanent or time-bound (with an expiry date)
- Containers can *request* access; operators approve or reject via the UI
- HTTP: full request/response logged in the network log
- HTTPS: tunneled through CONNECT (contents not intercepted)

### Docker Socket Proxy
- Every devcontainer gets its own Unix socket at `/tmp/dc-sockets/<name>/docker.sock`; the per-container *directory* is mounted into the container (at `/var/run/huddle`) and `DOCKER_HOST` points to the socket. A file mount of the socket itself would keep seeing the dead old inode after a Huddle restart; a directory mount does not. The old flat path `/tmp/dc-sockets/<name>.sock` remains as a symlink for containers created before this change.
- Fine-grained permissions per devcontainer, in two classes:
  - **Temporary actions** (mutations: container create/start/stop/restart/remove/update/exec, image pull/build/push/remove/tag, volume create/remove/prune, network create/remove/connect/disconnect) — only effective while the time-bound grant (1–120 minutes) is active *and* the action toggle is enabled in the portal
  - **Always-allowed actions** (read-only: list/inspect/logs/stats, ping/version/events) — independent of the timer, enabled per action
  - Secure by default: **all actions are off by default**; the operator explicitly enables what each devcontainer may do. Be extra cautious with `image.push`: pushing goes through the host daemon and does not pass the egress firewall
- Policy is enforced per request:
  - `docker ps` → filtered to the container's own started containers
  - `docker run` → allowed; label `huddle.parent` added automatically
  - `docker exec` → only the container's own child containers, never the devcontainer itself
  - `docker rm` / `docker rmi` → only resources the container created itself
  - `docker volume rm` / network delete → only the container's own (labeled) resources; `dc-net-*` networks are untouchable
  - `docker volume prune` → limited to the container's own volumes via an injected label filter
  - `docker push` → only self-built (labeled) images
  - `docker images` → all images (read-only)
- Grants and action toggles survive a Huddle restart; proxy sockets are recreated on restart

### Container management
- Overview of all devcontainers with status, image, uptime, and pending rule requests
- Start a new devcontainer from a snapshot or base image (IntelliJ / Rider / VS Code)
- Commit a running container to a snapshot image
- Force-remove a container including network cleanup
- A per-container Docker socket proxy is created automatically on start

### Network log
- Every proxied HTTP request is logged (container, domain, method, path, status, headers, body — truncated at 20 KB)
- Admin actions (rule changes, grant changes, container operations) are logged
- Filterable by container, domain, and action prefix

### Live UI
- Angular 21 SPA on port 3000
- WebSocket connection pushes a `reload` event on every state change
- Unified icon system (`app-icon`) backed by a central SVG registry
- Pie-action menus in the firewall and container views (approve / snooze / reject)


---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js 24 LTS (Alpine) |
| Backend | Fastify 5, TypeScript 5 |
| Database | SQLite via better-sqlite3 (WAL mode) |
| WebSocket | ws |
| Frontend | Angular 21 (standalone components, signals) |
| Build | Angular CLI, esbuild |
| Container | Docker multi-stage build |

---

## Getting Started

**Requirements:** Docker or Podman, Node.js 18+

Huddle's packages are public, so no GitHub token or registry login is needed.

### 1. Install the CLI

```bash
npm install -g @infosupport/huddle-cli
```

### 2. Start Huddle

```bash
huddle init
```

`huddle init` pulls the latest Huddle image and starts the container. It automatically detects whether Docker or Podman is available; use `huddle init --runtime <docker|podman>` (or the `HUDDLE_RUNTIME` env var) to pick a runtime explicitly. The web UI is available at `http://localhost:3000`.

After that, you start devcontainers directly from a project directory:

```bash
huddle
```

---

## Building base images (optional)

Huddle builds base images automatically when you start a devcontainer. To speed this up, you can build them ahead of time:

```bash
docker build -t base-devimage-vscode    -f base-devimage-vscode/Dockerfile    .
docker build -t base-devimage-intellij  -f base-devimage-intellij/Dockerfile  .
docker build -t base-devimage-rider     -f base-devimage-rider/Dockerfile     .
```

---

## Starting containers

You can start devcontainers via the CLI or via the web UI at `http://localhost:3000`.

### Via the CLI

From a project directory you start a devcontainer with a single command:

```bash
huddle                            # IntelliJ (default), current directory
huddle --ide rider                # Rider
huddle --ide vscode               # VS Code
huddle ./my-project               # a different directory
huddle --ide vscode ./my-project
```

Other options:

```bash
huddle --name my-container        # custom container name
huddle --empty                    # container without a workspace
```

After starting, the CLI shows the container name and how to open it in your IDE.

### Opening in JetBrains (IntelliJ / Rider)

1. Open **JetBrains Gateway**
2. Go to **Remote Development → Dev Containers**
3. Select the started container
4. Click **Open Project** and choose the project directory in the container

The CLI also prints a direct gateway link once the JetBrains backend has started (this can take a few seconds).

### Opening in VS Code

1. Open VS Code
2. Open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
3. Choose **Dev Containers: Attach to Running Container**
4. Select the container name the CLI printed

---

## Managing the firewall

Blocked requests are visible in the web UI under **Firewall**. Via the CLI:

```bash
huddle fw list               # list of recent requests
huddle firewall list -i      # interactive mode
```

When a devcontainer tries to reach a blocked domain, the request appears on the Firewall page. From there you can allow the domain (permanently or temporarily) or reject it — per container or globally.

---

## AI configuration

When building a base image, Huddle can automatically bake AI CLI configurations (such as `CLAUDE.md`, `settings.json`, agents, and skills) into the container. You manage this through the Huddle settings: set the path to your own AI config directory there. Huddle mounts that directory when building the image.

| AI tool | Source path (host) | Target path (container) |
|---------|--------------------|-------------------------|
| claude | `<your-ai-config-dir>/claude/` | `/home/vscode/.claude` |

---

## Extensions

Huddle has a runtime extension platform. Extensions are `.zip` files you upload through the UI — no restart needed. After uploading, the extension appears as a sub-item in the sidebar.

### Building an extension

```
my-extension.zip
├── manifest.json       ← required: id, name, version, settings
├── index.js            ← backend (CommonJS, Node.js)
└── frontend/
    └── component.js    ← UI as a Web Component (optional)
```

**`manifest.json`:**
```json
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "1.0.0",
  "settings": [
    { "key": "apiKey", "label": "API key", "secret": true }
  ]
}
```

**`index.js`** — export a `register(ctx)` function:
```js
exports.register = async function(ctx) {
  ctx.app.get('/api/ext/my-extension/data', async (req, reply) => {
    const key = ctx.getSetting('apiKey');
    return { data: '...' };
  });
};
```

**`frontend/component.js`** — Web Component for the in-app UI:
```js
class MyExtension extends HTMLElement {
  connectedCallback() {
    this.innerHTML = '<h1>Hello from the extension</h1>';
  }
}
customElements.define('ext-my-extension', MyExtension);
```

### Extension context (`ctx`)

| | |
|---|---|
| `ctx.app.get/post/put/delete(path, handler)` | Register a route under `/api/ext/<id>/` |
| `ctx.getSetting(key)` / `ctx.setSetting(key, value)` | Read/write settings (SQLite) |
| `ctx.fetch(url, opts)` | HTTP call through the Huddle proxy — appears as `ext:<id>` in the network log |
| `ctx.runInContainer(name, cmd)` | Run a shell command in a running devcontainer |
| `ctx.events` | Listen to Huddle events |
| `ctx.db` | Direct SQLite access |
| `ctx.log(msg)` | Log to the Huddle console |

### Firewall and external calls

External calls via `ctx.fetch()` go through the Huddle proxy. The domain must be on the allowlist (**Firewall** → find the domain → **Allow**). Requests appear in the network log as `ext:<id>`.

### Example: Aikido Security

The built-in Aikido extension lives in `gateway/extensions/aikido/`. After loading (automatically on start), **Aikido Security** appears in the sidebar. Functionality:

- Fetch open security issues per workspace from the Aikido API
- Inject issues as context into a running devcontainer (`aikido/AIKIDO_CLAUDE.md`, `AIKIDO_CONTEXT.md`)
- Write an MCP server (`aikido-mcp-server.js`) into the container so Claude can fetch issues and trigger scans directly
- Install an `aikido-fix` script that starts Claude with the right context

You configure credentials (Client ID + Secret) through the UI under **Aikido Security → Settings**.

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/rules` | List rules (filter: `?status=`, `?container=`) |
| POST | `/api/rules` | Create a rule |
| PUT | `/api/rules/:id` | Update a rule's status or expiry |
| POST | `/api/rules/:id/resolve` | Resolve a requested rule as allow/deny (per container or global) |
| DELETE | `/api/rules/:id` | Delete a rule |
| GET | `/api/docker/containers` | List devcontainers with pending rule requests |
| GET | `/api/docker/containers/:name` | Container detail + associated rules |
| POST | `/api/docker/start` | Start a new devcontainer |
| POST | `/api/docker/containers/:name/snapshot` | Commit a container to an image |
| DELETE | `/api/docker/containers/:name` | Force-remove a container |
| GET | `/api/docker/images` | List snapshot images |
| GET | `/api/authz/grants` | List active Docker socket grants |
| PUT | `/api/authz/grants/:container` | Grant Docker access (body: `{ minutes }`) |
| DELETE | `/api/authz/grants/:container` | Revoke Docker access |
| GET | `/api/authz/docker-actions` | Action catalog (kind, group, label, default) |
| GET | `/api/authz/docker-actions/:container` | Effective action toggles + grant per container |
| PUT | `/api/authz/docker-actions/:container/:action` | Enable/disable an action (body: `{ enabled }`) |
| GET | `/api/audit` | Network log (filter: `?container=`, `?domain=`, `?action=`) |

All state-mutating endpoints send a WebSocket `{ type: "reload" }` event to connected clients.

---

## Repository layout

```
.
├── gateway/                     ← Huddle gateway (Fastify API + Angular UI)
│   ├── src/
│   │   ├── index.ts             # Init DB, start proxy + API, restore socket proxies
│   │   ├── proxy.ts             # HTTP/HTTPS proxy (port 80), rule enforcement, audit
│   │   ├── api.ts               # Fastify REST API + WebSocket push (port 3000)
│   │   ├── docker.ts            # Docker API helpers, container lifecycle
│   │   ├── socket-proxy.ts      # Per-container Docker socket proxy with label policy
│   │   ├── rules.ts             # Rule lookup with per-container + global fallback
│   │   ├── db.ts                # SQLite schema, network log, Docker grants
│   │   └── events.ts            # In-process event bus for state-change notifications
│   └── frontend/src/app/
│       ├── pages/               # dashboard, containers, firewall, docker-access, audit
│       ├── shared/
│       │   ├── icons/           # Central SVG icon registry (icons.ts)
│       │   └── components/      # <app-icon>, pie-menu
│       └── core/
│           ├── models/          # Rule, Container, Grant, AuditLog types
│           └── services/        # ApiService, StateService, ModalService
│   └── extensions/aikido/       ← Built-in Aikido Security extension
├── cli/                         ← Cross-platform CLI (`huddle`)
├── .devcontainer/               ← Devcontainer setup for the Huddle repo itself
├── base-devimage-rider/         ← Dockerfile for Rider devcontainers
├── base-devimage-intellij/      ← Dockerfile for IntelliJ devcontainers
└── base-devimage-vscode/        ← Dockerfile for VS Code devcontainers
```

---

## Development setup

Want to work on Huddle itself? Huddle is a monorepo with two parts: the
**gateway** (Fastify API + Angular UI + proxy) and the **CLI**.

**Requirements:** Node.js 20+ (24 LTS recommended), Docker or Podman, Git.

```bash
git clone https://github.com/infosupport/huddle.git
cd huddle

npm install            # installs dependencies for gateway and cli
npm run build          # builds the gateway (API + frontend)
npm run cli:build      # builds the CLI
npm run cli:typecheck  # type-checks the CLI

npm start              # runs the gateway locally (UI at http://localhost:3000)
```

Running tests:

```bash
npm --prefix gateway test          # unit + e2e tests (vitest)
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full workflow, branching
strategy, commit conventions, and coding standards.

### Experimental builds

An experimental build publishes a full Huddle release (CLI + all Docker images)
under the tag `experiment-<nr>`, so anyone can try it with:

```bash
huddle experiment use <nr>     # switch to the experimental build
huddle experiment status       # show the active channel
huddle experiment reset        # back to the stable release
```

There are two ways an `experiment-<nr>` build gets published:

- **Automatically** — pushing to an `experiment/<issuenr>-<description>` branch
  in this repo publishes `experiment-<issuenr>` (see `publish-experiment.yml`).
- **On demand by a maintainer** — for a **fork PR** or any ad-hoc branch that
  never triggers the automatic flow. A maintainer runs:

  ```bash
  gh workflow run experiment-publish.yml -f pr=68        # keyed on the PR number
  gh workflow run experiment-publish.yml -f ref=my-branch -f key=123
  ```

  This is a `workflow_dispatch`, so only users with write access can start it —
  fork code is only ever built on an explicit maintainer action, never
  automatically. Once the run finishes, `huddle experiment use 68` works for
  everyone. Because GitHub issues and PRs share one number space, a PR-based
  key never collides with an issue-based one.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `docker login ghcr.io` or `npm install` fails with **401/403** | Your token expired or lacks the `read:packages` scope. Create a new token and log in again (see [Getting Started](#getting-started)). |
| `huddle init` finds no runtime | Make sure Docker or Podman is running. Force it explicitly with `huddle init --runtime docker` (or `podman`), or set `HUDDLE_RUNTIME`. |
| Web UI not reachable at `http://localhost:3000` | Check that the Huddle container is running (`docker ps`). The management API binds to `127.0.0.1` by default — reach it locally, not from another host. |
| Devcontainer can't reach a domain | Expected behavior: all traffic goes through the firewall. Allow the domain via **Firewall** in the UI or `huddle fw list`. |
| JetBrains Gateway doesn't see the container right away | The JetBrains backend needs a moment to start; the CLI prints the gateway link once it's ready. |
| `docker` inside the devcontainer gives *permission denied* | Docker access runs through a time-bound grant. Grant access via **Docker Access** in the UI (or `PUT /api/authz/grants/:container`). |
| Port 80 already in use | Another proxy/web server is using port 80. Stop that service or adjust the port mapping when starting the Huddle container. |

Need more logs? The network log and admin actions are in the UI under
**Network log**; view container logs with `docker logs <container>`.

---

## FAQ

**Is Huddle a replacement for a corporate firewall or VPN?**
No. Huddle shields *devcontainers* at the application level (per-domain
allowlist, controlled Docker actions). It complements, but does not replace,
network infrastructure.

**Does Huddle work with Podman?**
Yes. `huddle init` automatically detects Docker or Podman; you can force it with
`--runtime` or the `HUDDLE_RUNTIME` env var.

**Does Huddle intercept HTTPS traffic?**
HTTP requests are logged in full. HTTPS is tunneled through `CONNECT`; its
contents are not intercepted, only the target domain is checked against the
allowlist.

**Where is state stored?**
In a local SQLite database (WAL mode) inside the Huddle container. Firewall
rules and Docker grants survive a restart.

**Do I have to build the base images myself?**
No. Huddle builds them automatically when you start a devcontainer. Building them
ahead of time can speed this up (see [Building base images](#building-base-images-optional)).

**Can I use Huddle in production?**
Huddle is provided "AS IS" without warranty (see below). Use at your own risk.

---

## Contributing

Contributions are welcome! Please read first:

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to report bugs, propose features, and
  open a pull request.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — community behavior guidelines.
- [`SECURITY.md`](SECURITY.md) — report security issues **privately**, not as a
  public issue.

Report bugs and ideas via GitHub Issues:
**[github.com/infosupport/huddle/issues](https://github.com/infosupport/huddle/issues)**

---

## Support & SLA

Huddle is free, open source software, provided **"AS IS"**, **without any
warranty** (see the [GPL v3](LICENSE), sections 15–17).

- There is **no SLA** and **no guaranteed response time**.
- Support is provided on a **volunteer basis** by the community.
- Issues and pull requests are welcome, but there is **no guarantee** that a
  report will be picked up or implemented.

See [`SUPPORT.md`](SUPPORT.md) for details.

---

## License

Huddle is licensed under the **GNU General Public License v3.0 (or later)**.
See the [`LICENSE`](LICENSE) file for the full text.

```
Copyright (C) 2026 Info Support B.V.

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU General Public License for more details.
```
