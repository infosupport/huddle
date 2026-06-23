# Huddle DMZ Portal — Gateway

Huddle is a security gateway that sits between dev containers and the outside world. It enforces per-domain firewall rules, brokers time-limited access to the host Docker socket, and provides a management UI for operators.

## Architecture

```
Dev container
  └─ HTTP/HTTPS traffic → Huddle proxy (port 80)
       └─ rules engine → allow / deny / request
  └─ Docker socket → /tmp/dc-sockets/<name>.sock (per-container proxy)
       └─ label-based isolation + time-limited grant check

Browser
  └─ Angular SPA (port 3000) + WebSocket live push
       └─ Fastify REST API (/api/...)
```

Two servers run inside the same process:

| Server | Port | Purpose |
|--------|------|---------|
| HTTP proxy | 80 | Forward/intercept all outbound container traffic |
| API + UI | 3000 | REST API, Angular frontend, WebSocket push |

## Features

### Firewall
- Per-container and global allow/deny rules stored in SQLite
- Rules can be permanent or time-limited (expiry timestamp)
- Containers can *request* access; operators approve or deny via the UI
- HTTP: full request/response logged to audit log
- HTTPS: tunnelled via CONNECT (content not intercepted)

### Docker Socket Proxy
- Each dev container gets its own Unix socket at `/tmp/dc-sockets/<name>.sock`
- Access is gated by a time-limited grant (1–120 minutes)
- Policy enforced per request:
  - `docker ps` → filtered to own spawned containers only
  - `docker run` → allowed; `huddle.parent` label injected automatically
  - `docker exec` → only own child containers, never the devcontainer itself
  - `docker rm` / `docker rmi` → only resources the container created
  - `docker images` → all images (read-only)
- Grants survive a Huddle restart; proxy sockets are re-created on startup

### Container Management
- List all devcontainers with status, image, uptime and requested-rule count
- Start a new devcontainer from any snapshot or base image (IntelliJ / Rider)
- Commit a running container to a snapshot image
- Force-delete a container and clean up its network
- Per-container Docker socket proxy created automatically on start

### Audit Log
- Every proxied HTTP request is logged (container, domain, method, path, status, headers, body, truncated at 20 KB)
- Admin actions (rule changes, grant changes, container operations) are logged
- Filterable by container, domain, action prefix

### Live UI
- Angular 21 SPA served on port 3000
- WebSocket connection pushes a `reload` event whenever state changes
- Unified icon system (`app-icon`) backed by a central SVG registry
- Pie-action menus on firewall and container views (approve / snooze / deny)

### Bug Tracker
- Operators can file bug reports from the UI; saved as Markdown files under `/bugtracker/bugs/`
- Solved bugs can be moved to `/bugtracker/solved/`

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 (Alpine) |
| Backend | Fastify 5, TypeScript 5 |
| Database | SQLite via better-sqlite3 (WAL mode) |
| WebSocket | ws |
| Frontend | Angular 21 (standalone components, signals) |
| Build | Angular CLI, esbuild |
| Container | Docker multi-stage build |

## Project Structure

```
gateway/
├── src/
│   ├── index.ts          # Entry: init DB, start proxy + API, restore socket proxies
│   ├── proxy.ts          # HTTP/HTTPS proxy (port 80), rule enforcement, audit logging
│   ├── api.ts            # Fastify REST API + WebSocket push (port 3000)
│   ├── docker.ts         # Docker API helpers, container lifecycle
│   ├── socket-proxy.ts   # Per-container Docker socket proxy with label-based policy
│   ├── rules.ts          # Rule lookup with per-container + global fallback
│   ├── db.ts             # SQLite schema, audit log, docker grants
│   └── events.ts         # In-process event bus for state-change notifications
└── frontend/
    └── src/app/
        ├── pages/        # dashboard, containers, container-detail, firewall, docker-access, audit
        ├── shared/
        │   ├── icons/    # Central SVG icon registry (icons.ts)
        │   └── components/
        │       ├── icon/        # <app-icon name="..." [size]="20" />
        │       └── pie-menu/    # Radial action menu (SVG overlay, N families)
        └── core/
            ├── models/   # Rule, Container, Grant, AuditLog types
            └── services/ # ApiService, StateService, ModalService
```

## Development

### Prerequisites
- Node.js 20+
- Docker (for running the full stack)

### Run locally (gateway only)

```bash
npm install
npm run build          # compile TypeScript + Angular
node dist/index.js
```

Frontend dev server with live reload:

```bash
cd frontend
npm install
ng serve               # http://localhost:4200 (proxies /api to :3000)
```

### Docker build

```bash
docker build -t huddle-gateway .
docker run -p 3000:3000 -p 80:80 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v huddle-data:/data \
  huddle-gateway
```

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/rules` | List rules (filter: `?status=`, `?container=`) |
| POST | `/api/rules` | Create rule |
| PUT | `/api/rules/:id` | Update rule status / expiry |
| POST | `/api/rules/:id/resolve` | Resolve a requested rule as allow/deny, scoped to the rule or global policy |
| DELETE | `/api/rules/:id` | Delete rule |
| GET | `/api/docker/containers` | List devcontainers with requested-rule counts |
| GET | `/api/docker/containers/:name` | Container detail + rules |
| POST | `/api/docker/start` | Start a new devcontainer |
| POST | `/api/docker/containers/:name/snapshot` | Commit container to image |
| DELETE | `/api/docker/containers/:name` | Force-delete container |
| GET | `/api/docker/images` | List snapshot images |
| GET | `/api/authz/grants` | List active Docker socket grants |
| PUT | `/api/authz/grants/:container` | Grant Docker access (body: `{ minutes }`) |
| DELETE | `/api/authz/grants/:container` | Revoke Docker access |
| GET | `/api/audit` | Audit log (filter: `?container=`, `?domain=`, `?action=`) |
| GET | `/api/bugs` | List bug reports |
| POST | `/api/bugs` | File a bug report |

All state-mutating endpoints emit a WebSocket `{ type: "reload" }` event to connected clients.
