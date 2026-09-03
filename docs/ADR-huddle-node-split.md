# Splitting Huddle Node from Huddle Gateway

Status: **implemented** — steps 1–6 landed; step 7 partially (see the table).
The role is the deployment: `HUDDLE_ROLE` is `node` or `gateway`, there is no
combined `all` role and no `HUDDLE_HOST_MODE` opt-in. Nothing here is kept for
backwards compatibility.
Branch: `feat/sbx-sandboxes-rebased` (rebased onto `feat/69-export-import-rules-rebased`).

---

## 1. Starting point

*Everything in section 1 describes Huddle **before** the split — kept because the
rest of this document argues against it. For what runs where now, see section 2
and the step table in section 3.*

### 1.1 How Huddle started

`huddle init` (`cli/src/init.ts`) is the only startup path. It is a thin
orchestrator around one `docker run`:

```
huddle init
  ├── resolveRuntime()            docker | podman | rancher   (cli/src/runtime.ts)
  ├── pull gateway image + base devcontainer images
  ├── volume create  huddle-data
  ├── network create devcontainer-net  --internal
  ├── rm -f huddle
  ├── mkdir /tmp/dc-sockets       (on the ENGINE host, not the CLI host)
  ├── docker run -d --name huddle
  │      --network <default>                 ← has internet
  │      -p 3000:3000                        ← portal/API
  │      -p 127.0.0.1:32768:32768            ← sbx egress proxy
  │      -v huddle-data:/data                ← SQLite + CA + extensions
  │      -v <runtime.socketPath>:/var/run/docker.sock
  │      -v /tmp/dc-sockets:/tmp/dc-sockets
  │      -v ~/.huddle:/huddle-home:rw        ← config.json (source of truth)
  │      -v <firewallRulesFolder>:/firewall-rules:rw
  │      -v <extensionsFolder>:/extensions:ro
  │      -v ~/.huddle-sbx:/sbx-bridge        ← the SBX file mailbox
  ├── network connect devcontainer-net huddle
  └── sbx host CA + startBridge()            ← host-side watcher, detached node process
```

Everything else — `huddle start`, `huddle firewall …`, `huddle sbx …` — is an
HTTP client against `http://localhost:3000` with the operator token from
`~/.huddle/config.json` (`cli/src/api.ts`). `huddle restart` = `runInit` again.
There is no `huddle stop`. The exception is `huddle logs`, which reads
`~/.huddle/node.log` and `docker logs huddle` straight from disk: the log of a
Node that failed to start is exactly the log you need, and the API cannot serve
it.

### 1.2 What runs in `huddle-gateway`

`gateway/src/index.ts` starts, in one process:

| Concern | Module | Belongs to |
| --- | --- | --- |
| SQLite (`/data/huddle.db`) | `db.ts` | **Node** |
| settings migration | `settings-migration.ts` | **Node** |
| MITM CA (`/data/ca.*`) | `tls-ca.ts` | **shared** (gateway signs, Node distributes) |
| filtering proxy on `:80` | `proxy.ts` | **Gateway** |
| sbx egress proxy on `:32768` | `proxy.ts` | **Gateway** |
| REST API + WS + portal | `api.ts` (`:3000`, `@fastify/static` → `dist/ui/browser`) | **Node** |
| devcontainer lifecycle | `docker.ts` (55 kB) | **Node** |
| per-container Docker socket filter | `socket-proxy.ts` (56 kB) | **Node** (host-side) |
| the socket file that filter is reached through | `socket-relay.ts` | **Gateway** (it is the one on the engine — see 17) |
| container terminals / PTY | `terminal.ts`, `pty-manager.ts` | **Node** |
| sudo grant sweeper | `sudo-grant.ts` | **Node** |
| extensions | `extensions/` | **Node** |
| resolv.conf sanitising | `dns-egress.ts` | **Gateway** |
| SBX orchestration | `sbx.ts`, `sandbox/` | **Node** |
| firewall rules/groups/folder | `rules.ts`, `firewall-*.ts` | **shared** |

So: of ~330 kB of gateway source, only `proxy.ts` (43 kB), `dns-egress.ts`,
`rules.ts` (evaluation half) and part of `tls-ca.ts` are genuinely the network
enforcement point. The rest lives there because that container historically
hosted all of Huddle.

### 1.3 Frontend / backend hosting

Angular is built into `gateway/dist/ui/browser` and served by the same Fastify
instance that serves `/api` (`api.ts:254`), on a **hardcoded** `API_PORT = 3000`
(`api.ts:79`). Auth is a single operator token (`auth.ts`), deliberately not
source-IP based — *because* the gateway is a published container and a
devcontainer, the operator and a LAN neighbour all arrive with the same bridge
source IP.

### 1.4 Devcontainer + firewall wiring (the data plane)

```
devcontainer  ── devcontainer-net (--internal, no default route) ──▶ huddle-gateway ──▶ internet
                                                                     (also on the default bridge)
```

Enforcement is **two-layer** and both layers matter:

1. `devcontainer-net` is `--internal`: no route off the host at all.
2. Inside each devcontainer (`docker.ts:153-176`, `:680`, `:806`):
   ```
   iptables -t nat -A OUTPUT -p tcp --dport 80 ! -d $HUDDLE_IP -j DNAT --to $HUDDLE_IP:80
   iptables -A OUTPUT -o lo        -j ACCEPT
   iptables -A OUTPUT -p tcp -d $HUDDLE_IP -j ACCEPT
   iptables -A OUTPUT -p tcp       -j DROP
   ```
   `$HUDDLE_IP` is the gateway's address **on `devcontainer-net`**.

The gateway is therefore the only path out, and it must stay a container on that
network. Note layer 2 also means a devcontainer can currently reach the gateway's
**control plane** (`:3000`) — only the operator token stops it.

### 1.5 How SBX talks to the host today — the folder-sync bridge

`sbx` is a Windows/host binary. The gateway cannot exec it, so:

```
gateway container                                host (Windows / git bash / node)
─────────────────                                ────────────────────────────────
gateway/src/sandbox/ops.ts
   execFile('sbx', argv)
        ▼
/usr/local/bin/sbx  = bridge/sbx.sh              cli/src/sbx-bridge.ts  (runBridge)
   write  /sbx-bridge/req/<id>.req  (argv/line)  ──▶ poll req/ every 150 ms
   poll   /sbx-bridge/res/<id>.code (150 ms)     ◀── spawnSync(sbx, argv)
   replay .out/.err, exit with .code                 write .out/.err, .code LAST
```

* **Where it lives** — `bridge/sbx.sh` (baked into the image as
  `/usr/local/bin/sbx`), `bridge/sbx-watcher.sh` (bash reference impl),
  `cli/src/sbx-bridge.ts` (the Node watcher that actually runs), and the
  `~/.huddle-sbx → /sbx-bridge` mount in `cli/src/init.ts`.
* **Sync mechanism** — a bind-mounted folder, `req/` + `res/`, atomic rename,
  `.code` written last as the completion marker. 150 ms polling on both sides.
* **Processes** — one detached `huddle sbx bridge run` on the host
  (pid `~/.huddle/sbx-bridge.pid`, log `~/.huddle/sbx-bridge.log`), started
  best-effort by `huddle init`.
* **Lifecycle** — `huddle sbx bridge start|stop|status|run`. No supervision, no
  restart-on-crash, no health check beyond `process.kill(pid, 0)`.
* **Extra tax it imposes** — MSYS→Windows path translation (`xlate()` in both
  halves), `windowsHide` to stop a console window per spawn, a 300 s timeout,
  64 MB stdout cap, and `sbx-host-ca.ts` to install the CA on the host anyway
  (proving the CLI already reaches host trust stores).

**Everything in the bridge exists only because Huddle runs inside Docker.**

---

## 2. Target state — and what now runs

```
                       huddle CLI
                            │
                            ▼
              Huddle Node  (host process, :24842)
              ├── Angular portal + REST/WS API
              ├── SQLite, config, extensions
              ├── Docker/devcontainer orchestration  (native socket)
              ├── per-container Docker socket filter
              ├── SBX  ── execFile('sbx', …) directly ──▶ sbx
              └── control listener  :24843 ───┐
                                               │  policy + container feeds ▲
                                               ▼  effect/audit reports     │
   devcontainer ──▶ huddle-gateway (Docker: proxy :80, sbx proxy :32768) ──▶ network
```

Trust boundaries improve rather than weaken:

* Huddle Node is trusted host software — no longer reachable from
  `devcontainer-net` at all, so the control plane leaves the sandbox's blast
  radius entirely.
* The gateway keeps `--internal` + in-container iptables **unchanged**.
* The gateway no longer needs `/var/run/docker.sock`, which removes a
  container-escape primitive from the network-exposed component. It has no data
  volume, no `~/.huddle`, no published portal port and no database either — its
  entire input is two signed-for-by-token feeds and a read-only CA directory.
* The arrows are drawn the way the packets actually go: the gateway *pulls* both
  feeds and *posts* its reports. Node opens no connection into the container.

---

## 3. Migration boundary

Do **not** move code between directories yet. The first boundary is an
*interface*, not a move:

1. **One place that resolves every host-vs-container binding** (ports, socket
   path, data dir, mount points). Today these are scattered literals — some
   env-overridable, some hardcoded (`API_PORT`, `SOCKET_DIR`,
   `/var/run/docker.sock` ×9).
2. **An explicit role** the process starts in: `all` (today), `node`, `gateway`.
   `index.ts` becomes a role-driven composition root.

Only once both exist does moving files become a mechanical, reversible step.

### Step-by-step

| # | Step | Files | Behaviour moved | Tests | Risk / rollback |
| --- | --- | --- | --- | --- | --- |
| 1 | **`runtime-env.ts`** — single source for role + paths + ports; defaults byte-identical to today | new `gateway/src/runtime-env.ts`; `index.ts`, `api.ts`, `db.ts`, `auth.ts`, `docker.ts`, `terminal.ts`, `socket-proxy.ts`, `tls-ca.ts`, `extensions/loader.ts`, `sbx.ts` | none | unit tests on the resolver (container defaults, host defaults, env overrides, role parsing) | pure refactor; revert the commit |
| 2 | **Role-gated startup** — `index.ts` starts proxies only in `gateway`/`all`, API/Docker/sbx only in `node`/`all` | `index.ts` | none (`all` is the default) | boot smoke test per role | default unchanged |
| 3 | **`huddle node` command** — run Huddle Node in the foreground on the host, port 24842 | `cli/src/node.ts`, `cli/src/index.ts` | nothing yet; additive | CLI arg tests | additive |
| 4a | **Control-plane seam** — the proxy talks to one `controlPlane` facade instead of importing `rules`/`db`/`docker`/`registry` directly | new `gateway/src/control/plane.ts`; `proxy.ts` (imports only) | none | facade delegation + swap-after-destructure | pure indirection; revert the commit |
| 4b | **Split evaluation from its effects** — `decide()` is pure over a policy snapshot and returns an effect list; `checkRule` becomes read → decide → apply | new `rule-match.ts` (pure vocabulary + matching, extracted), new `control/decide.ts`; `rules.ts` | none | new `decide.test.ts` (21 tests, no DB); `rules.test.ts` unchanged | behaviour-preserving refactor |
| 4c | **Control channel, read half** — `/control/health`, `/control/policy`, `/control/containers` on Node, behind a token of the gateway's own | `auth.ts` (second token), `api.ts` (guard), new `control/{http,feed,routes}.ts` | none — nothing consumes it yet | `control-http.test.ts` (pure, 15); `control-routes.test.ts` (12, DB-gated) | additive; no existing route changes |
| 4d | **Control channel, write half** — the effect list and audit entries the gateway produces flow back to Node | `control/routes.ts`, proxy-side queue | audit sink | contract tests both sides | additive |
| 4e | **Remote binding** (done) — the facade reads the polled feeds instead of SQLite/Docker; the in-process binding is gone | `control/plane.ts`, `control/client.ts`, `control/select.ts`, `control/apply.ts` | rule evaluation input | `test/helpers/local-plane.ts` drives the real client against an in-process Node, so `rules.test.ts` still tests feed → decide → apply end to end | not a flag — the gateway has no database to fall back to |
| 4e′ | **Self-traffic guard** — one tested predicate instead of the `'huddle'` literal at three proxy sites; loopback refused regardless of policy | new `proxy-self.ts`, `proxy.ts` | none — the sudo-audit exception is preserved | `proxy-self.test.ts` (14, pure) | self-addressed hosts stop appearing as `requested` rules (blocker 13) |
| 5 | **SBX direct exec** (done) — mailbox dropped; `sandbox/ops.ts` execs `sbx` on the host | deleted `bridge/`, `cli/src/sbx-bridge.ts`, `gateway/sbx.sh`, `run-sandbox-mode.sh`, the `/sbx-bridge` mount; new `cli/src/sbx-host.ts` | container→host hop removed | `sbx-host-only.test.ts` (4); existing sbx tests unchanged | sbx now needs `huddle node` — see the gap below |
| 6 | **`huddle init` starts both** (done) — Huddle Node detached on the host first, then the gateway container pointed at it | `cli/src/init.ts`, `cli/src/node.ts`, `cli/src/control-address.ts` | container startup responsibilities → CLI | `cli/test/node.test.ts` (not runnable in this devcontainer — blocker 9) | no escape hatch: a gateway without Node denies everything, which is the correct failure |
| 7 | **Slim the gateway** (partial) — the *mounts* are gone (no Docker socket, no data volume, no `~/.huddle`, no published portal) and `boot-gateway.ts` keeps `db`/`docker`/`api` out of the process via a dynamic import in `index.ts`; the image still compiles and ships every source file | `cli/src/init.ts`, `gateway/src/index.ts`, new `gateway/src/boot-gateway.ts`, `gateway/src/boot-node.ts` | — | an import-graph test pinning that nothing reachable from `boot-gateway.ts` imports `db`/`docker`/`api` | dropping files from the image is a build change only; the runtime guarantee already holds |

**No compatibility rule.** There is no combined role to fall back to: the
gateway has no database, no Docker socket and no API, and Huddle Node binds
loopback on 24842. An old `huddle init` against a new image (or the reverse)
does not work and is not meant to.

---

## 4. SBX migration — KEEP vs REMOVE

### KEEP (domain + process management, host-agnostic)

```
gateway/src/sandbox/protocol.ts    types + name/target validation
gateway/src/sandbox/ops.ts         execFile passthrough, output parsers   ← keep, retarget
gateway/src/sandbox/reconcile.ts   diff + apply
gateway/src/sandbox/registry.ts    per-sandbox identity (mint/has/drop)
gateway/src/sandbox/auto-sync.ts   debounced reconcile + policy-log ingest
gateway/src/sbx.ts                 facade: startSandbox/trustCa/…
cli/src/sbx-host-ca.ts             host CA trust (already host-native)
```

The `:32768` sbx egress proxy **stays in the gateway container** — sandbox
traffic must keep crossing the enforcement point.

`sandbox/projection.ts` was on this list and is gone: per-sandbox identity made
sbx' own policy engine redundant, so Huddle stopped mirroring its ruleset into
sbx and became the single enforcement point (docs/ADR-sbx-identity.md). The
fleet merge and the sandbox-name cache went with it.

### REMOVE / REPLACE (pure Docker→host workarounds)

```
bridge/sbx.sh                      container-side mailbox client
bridge/sbx-watcher.sh              bash host watcher
bridge/README.md
cli/src/sbx-bridge.ts              node host watcher + pid/log lifecycle
huddle sbx bridge {start,stop,status,run}
gateway/Dockerfile   COPY sbx.sh /usr/local/bin/sbx  +  HUDDLE_SBX_BRIDGE
cli/src/init.ts      the ~/.huddle-sbx → /sbx-bridge mount
run-sandbox-mode.sh  the whole mailbox self-check
sandbox/ops.ts       the 300 s bridge timeout + MSYS path xlate
```

After step 5, `ops.ts` runs `execFile('sbx', argv)` for real. The parsers, the
validation and the reconcile loop are untouched — that is the reusable part.

### What step 5 actually landed

The prediction held: the domain layer never knew about the bridge. `ops.ts` was
already `execFile($HUDDLE_SBX_BIN, argv)` with a validated argv array and no
shell, so on the host it needs no retargeting at all — the mailbox lived
entirely in *what `sbx` on the container's PATH resolved to*. Removing it was a
deletion plus comment corrections, not a rewrite. The MSYS path translation
(`/t/x` → `T:\x`) went with it: it existed because argv crossed from a Linux
container to a Windows host mid-call, which no longer happens.

Two things were extracted rather than deleted, because they are real host
problems and outlive the bridge: resolving *which* binary (`sbx` vs `sbx.exe`
vs `HUDDLE_SBX_BIN`) and `windowsHide`, which stops Windows opening a console
window per spawn. They are now `cli/src/sbx-host.ts`, which `sbx-host-ca.ts`
already depended on.

**The gap this opened, and how step 6 closed it.** sbx is usable only where sbx
can actually run: a process in the `node` role on the host, or any process with
an explicit `HUDDLE_SBX_BIN`. Between steps 5 and 6 that was a real regression
in reach — the gateway container could no longer drive sandboxes and nothing
started Node automatically. Step 6 made `huddle init` start Huddle Node on the
host first, so the supported configuration is now exactly the one where sbx
works. `ops.unavailableReason()` makes the failure legible — the old
path would have reported `'sbx' not found on PATH`, which reads as a missing
install and sends people off to reinstall Docker Sandboxes.

---

## 5. Node ↔ Gateway control plane

Deliberately **not** a generic host bridge. Four routes on Huddle Node, all
served by a **separate listener** (port 24843) so the operator-token API on
24842 stays on loopback and is never the surface a container talks to:

| Need | Shape |
| --- | --- |
| firewall policy | `GET /control/policy` — full snapshot, content-hash `ETag`, `304` when unchanged |
| the IP→container map | `GET /control/containers` — same shape; removes the proxy's need for the Docker socket |
| effects + audit + sudo lines back | `POST /control/report` — batched, session-keyed refs |
| health | `GET /control/health` |

**Pull, not push, and snapshot, not delta.** The gateway polls; Node never has
to know where the gateway is or retry into it. Snapshots keep it idempotent and
self-healing, matching the existing `reconcile()` philosophy.

**Two tokens, not one.** The gateway holds `HUDDLE_GATEWAY_TOKEN`, which opens
`/control/*` and nothing else; the operator token stays on the host and is what
the portal and `huddle …` use. Bearer only — a query parameter would end up in
the audit log the gateway itself writes.

**Fail-closed, then fail-static.** Before the first feed arrives the proxy
denies everything: an empty policy is not "allow", it is "not yet configured".
Once a feed has arrived, the gateway keeps enforcing that policy while Node is
away, and the report queue accumulates under a byte cap and drains when Node
comes back. Enforcement never depends on Node being reachable, which is why
Node is not in the hot path of a single proxied request.

---

## 6. CLI lifecycle — answered

Settled by inspection in step 3 and confirmed by what step 6 shipped:

* **Attached or background?** `huddle init` should *daemonise* Huddle Node
  (`spawn(detached, stdio→logfile)`, the pattern `sbx-bridge.ts` already proves
  works cross-platform), and `huddle node` should run it in the foreground for
  development.
* **Single instance** — pid file `~/.huddle/node.pid` + a `GET /api/health`
  probe on `:24842`. A live Huddle answering there is "already running", not an
  error; a foreign process there is a hard error.
* **Logs** — `~/.huddle/node.log` (same convention as `sbx-bridge.log`).
* **Crashes** — no supervisor initially; `huddle init` is idempotent and
  restarts a dead Node. Revisit only if it proves necessary.
* **Cross-platform** — the CLI already runs on Windows/macOS/Linux and already
  detaches a background process; `runtime.socketPath` already abstracts the
  engine socket. `runtime-env.ts` picks `\\.\pipe\docker_engine` on win32.
  Untested on Windows in this devcontainer; it is the one part of step 6 that
  still needs a real run on the platform.
* **Where the gateway finds Node** — `cli/src/control-address.ts`, because it is
  a per-platform decision and a security one: an engine in a VM reaches the host
  as `host.docker.internal`, native Linux as the bridge gateway address, and the
  bind address Node uses has to be the matching one. See blocker 12.

---

## 7. Blockers / unexpected coupling found

1. **`proxy.ts` reads SQLite directly** (`checkRule`, `checkFleetRule`,
   `logAudit`). Splitting the process splits the database — hence step 4 before
   step 7.
2. **`proxy.ts` → `docker.resolveContainerByIp`** — the enforcement point needs
   the Docker socket purely to map a source IP to a container name. Step 4's
   pushed map removes that dependency and lets the socket mount go.
3. **`tls-ca.ts` is shared** — the gateway signs leaves, Huddle Node hands the CA
   to devcontainers and to `sbx trust-host`. The CA must live in one place and be
   readable by both; simplest is: Node owns `~/.huddle/ca.*`, gateway gets it
   mounted read-only.
4. **`ugrep` masquerades as `grep`** in the devcontainer and silently skips
   `gateway/src/api.ts` as "binary". Anyone auditing this codebase with `grep`
   gets false negatives on the largest file. Use `rg` or `grep --text`.
5. **`API_PORT` is hardcoded** to 3000 while `feat/port-24842` already moved the
   whole tree to 24842 — those must be reconciled when that branch merges.

   **Resolved.** `runtime-env.ts` (step 1) resolves it per role instead of a
   single literal: `hostMode ? 24842 : 3000`, overridable via `HUDDLE_API_PORT`.
   The container default stays 3000 (no publish step changes); Huddle Node
   defaults to 24842, which is what sections 2, 5 and 6 already assume.

### Found while implementing steps 1–3

6. **Huddle Node has no delivery mechanism.** `huddle node` can *run* a build but
   nothing *ships* one. The published CLI is `files: ["dist"]` with zero runtime
   dependencies, while Huddle Node is now a platform-specific, self-contained
   SEA executable. The earlier decision to bundle the gateway JavaScript build
   into the CLI is invalid: it was based on `better-sqlite3` native prebuilds,
   which were removed when the store moved to `node:sqlite`.

   **Resolved: platform-specific optional npm packages.** The CLI declares
   `@infosupport/huddle-node-win32-x64`,
   `@infosupport/huddle-node-darwin-x64`, and
   `@infosupport/huddle-node-darwin-arm64` as exact optional dependencies.
   npm selects the matching package from its `os`/`cpu` metadata, and the CLI
   resolves `bin/huddle-node[.exe]` there. This keeps install free of a
   postinstall download and makes the executable available offline once npm has
   it cached. `verify-sea.yml` builds and smoke-tests each target natively and
   stages the package as an artifact. `publish-npm.yml` builds and publishes all
   three native packages before the CLI. Windows signing and macOS
   signing/notarisation remain separate operational work.
7. **The resolv.conf seam.** `initContainerNetworks()` is a Docker call (Node),
   but the `/etc/resolv.conf` it corrupts belongs to the *gateway* container
   (`dns-egress.ts`). In one process those chain directly. Split, Node performs
   the connect and the gateway has to notice by itself.

   **Resolved.** Most connects already changed the container feed (a
   devcontainer starting or stopping), which the gateway was already reacting
   to (`scheduleSettlingSanitize()` in `boot-gateway.ts`'s `onDevcontainers`).
   The gap was the connects that don't: `rewireGatewayIntoDevcontainers()`
   reattaching the gateway to networks whose devcontainers already existed
   (a Node restart), which repollutes resolv.conf without changing `byIp` or
   `devcontainers`. `docker.ts` now bumps a `networkGeneration` counter on
   every successful `connectNetwork()`, and `feed-build.ts` folds it into the
   container feed's version — so the existing poll-and-react path fires on a
   bare reconnect too, still pull-based, no second channel. On a changed feed
   the gateway runs one sanitize pass immediately (within that poll cycle),
   then retains the settling spread (`SETTLING_DELAYS_MS`) to cover Podman
   finishing a delayed rewrite after the connect returned.
8. **`initDb()` and `initCa()` run in both roles.** Neither was cleanly
   one-sided at the time this was written: the proxy read rules and wrote audit
   rows from SQLite directly, and the CA was signed by the gateway but
   distributed by Node. A split deployment had to share `DB_PATH` and `CA_DIR`.

   **Resolved, DB half.** `boot-node.ts` calls `initDb()`; `boot-gateway.ts`
   does not — the proxy now reaches rules and audit through the `controlPlane`
   facade (blockers 1–2) instead of SQLite directly. **CA half stays, by
   design**: the gateway still signs leaves with the CA Node generates, mounted
   read-only per blocker 3.
9. **The CLI had no test harness.** `cli/package.json` now has a `test` script,
   a vitest devDependency and `vitest.config.ts`. The first two suites
   (`node.test.ts`, `control-address.test.ts`, 33 tests) had to be verified
   against the gateway's copy of vitest (`node
   ../gateway/node_modules/vitest/vitest.mjs run` from `cli/`), because
   `cli/package-lock.json` had no vitest entry and this devcontainer's own
   firewall denies `registry.npmjs.org`.

   **Resolved.** `cli/package-lock.json` now carries the vitest entry and
   `npx vitest run` passes standalone in `cli/` — 5 suites, 80 tests
   (`api-base-url`, `control-address`, `control-probe`, `logs`, `node`).
10. **`checkRule` is not a read — it writes, and it mints ids.** This is the
    blocker that reshaped step 4 into 4a/4b/4c. On a miss it `INSERT`s a
    `requested` rule so the operator sees the blocked host in the portal; it also
    refreshes last-seen metadata (`touchRule`, `setLastPath`), expires timed-out
    allows (`resetExpired`), fires `notifyStateChanged()`, and then **re-reads
    the row to return the database-assigned `ruleId`** that the audit entry
    references. A gateway holding only a pushed policy snapshot cannot produce
    that id — it is Node's to assign.

    So "push policy, evaluate locally" is not sufficient on its own. The shape
    that works: evaluation splits into a pure decision (applied immediately, so
    egress never waits on Node) plus an effect stream (`requested` rows, touches,
    expiries) that reaches Node asynchronously and is correlated there. The
    rejected alternative is a synchronous `POST /control/decide` per request,
    which puts Node in the hot path of every proxied request and stops all egress
    when it is down.

    *Step 4b implements that shape.* `decide()` returns the answer plus a
    `PolicyEffect[]`, and `create-requested` is an explicit effect rather than a
    hidden write. It is still applied synchronously against the local database,
    so nothing has changed yet — but the id now arrives from *applying* the
    effect instead of from inside the evaluation, which is what lets step 4c move
    the applier without touching the decision.

11. **`index.ts` and `proxy.ts` are the only CRLF files in the repo** (also on
    `main`). With `core.autocrlf=input` — the setting in this devcontainer — any
    edit normalizes them and turns a two-line change into a ~2000-line diff that
    conflicts with every concurrent branch. Steps 1–2 preserved CRLF via
    `git -c core.autocrlf=false add`. Normalizing both files to LF is worth doing,
    but as its own commit, on a quiet branch point.

12. **The two halves cannot reach each other without widening a bind address.**
    `api.ts` listened on `0.0.0.0`. In the container that is the only sensible
    choice — Docker reaches the API on the container's veth address and `-p
    3000:3000` decides what the outside world sees. On the host there is no
    publish step, so the same literal would put Huddle Node — which execs into
    containers, runs terminals and rewrites firewall policy — on every interface
    the machine has, with the operator token as the only barrier. Host mode
    therefore binds `127.0.0.1` (`apiBindHost`, overridable via `HUDDLE_API_HOST`).

    That is the safe default, and it collides with step 4c. A gateway CONTAINER
    reaching Huddle Node on the host works differently per platform: on Docker
    Desktop `host.docker.internal` reaches services bound to the host's loopback,
    but on Linux it resolves to the bridge address (`172.17.0.1`), where a
    loopback-bound Node is invisible. So on Linux the control channel needs
    either an explicit bind on the bridge address or a different transport.

    Recorded rather than guessed at, because the choice is a security decision,
    not a configuration detail: every option here is a new listener that
    devcontainers share a network segment with. Whatever 4c picks must come with
    the proxy-side guard that devcontainer traffic can never be forwarded to the
    control endpoint, regardless of what the operator has allowlisted.

    **Resolved.** `cli/src/control-address.ts` decides once, at init, and prints
    which branch it took: engine-in-a-VM → `host.docker.internal` with Node bound
    to `0.0.0.0`; native Linux → the bridge gateway address, with Node bound to
    exactly that address (not every interface); `HUDDLE_CONTROL_HOST` overrides
    both. The control channel is its OWN listener on 24843, so widening the bind
    address widens `/control/*` and nothing else — the operator-token API stays on
    loopback:24842. `devcontainer-net` is `--internal` and has no route to either
    address, and the proxy refuses self-addressed traffic regardless of policy
    (blocker 13), so a devcontainer has no path to the control channel: not by
    name, not by address, not through the proxy.

13. **Devcontainers are allowed to reach Huddle's own API — through the proxy.**
    The proxy refuses self-addressed traffic at all three entry points (plain
    HTTP, WebSocket upgrade, CONNECT), but the plain-HTTP site carries one
    deliberate exception: `POST :3000/api/audit/sudo`, the ingest devcontainers
    use to report sudo invocations. It is public by design (`devcontainerPublicApi`
    in `api.ts`) and it must keep working.

    That is a data-plane→control-plane dependency the split has to carry across:
    after the move, the endpoint no longer lives in the gateway's own process. The
    gateway will have to forward that one request to Node on the host, over
    whatever transport blocker 12 settles on — which makes it the same listener
    the control channel uses, reached by devcontainer traffic on purpose. So the
    guard cannot be "never forward to Node"; it has to be "forward exactly this
    one method+path, and nothing else."

    The check is now a tested predicate pair in `proxy-self.ts` rather than the
    string `'huddle'` repeated at three call sites, because that literal stops
    being Node's name the moment Node moves. `isSelfHost` also covers loopback,
    which the old comparison did not: a devcontainer asking the proxy for
    `localhost` had it resolved in the GATEWAY's namespace, and pointing it at the
    proxy's own listener loops it back into itself. Default-deny refused that in
    practice — no rule matches, so it was filed as `requested` and blocked — but
    it was one operator mistake away from being allowed. It is now refused
    regardless of policy.

    *Deliberate behaviour change:* self-addressed hosts no longer appear in the
    portal as pending `requested` rules, because they never reach rule
    evaluation. There is no rule an operator should ever write for them.

    **How the exception survived the split.** The endpoint moved to the host with
    the database, so forwarding it would have meant a devcontainer→host network
    path — exactly what 13 exists to prevent. It does not forward. The proxy
    *terminates* the request itself (`proxy.ts:handleSudoAudit`) and relays the
    line over the control channel it already holds open, which is authenticated,
    outbound-only and not reachable by the container. The devcontainer's contract
    is byte-identical (`POST http://huddle:<api-port>/api/audit/sudo`, same status
    codes), the body is capped at 8 KiB, and the container identity is still the
    gateway's own IP→container lookup — the `container` field the forwarder puts
    in its body has never been trusted and still is not. Node parses the line
    (`control/sudo-entry.ts`) because Node owns the database.

    With that, `api.ts` has no devcontainer-public carve-out left at all: every
    `/api/*` route is operator-only, and the API is on loopback where no container
    can reach it.

14. **`huddle migrate` told people to download the CA from an endpoint that no
    longer exists** — `curl -fsS http://huddle:3000/api/tls/ca.crt`. Found while
    wiring the sudo relay, and it was already dead code before the split: there is
    no `/api/tls/ca.crt` route anywhere in the gateway. Huddle-created containers
    never used it (they get the CA seeded inline at create time); only the
    `migrate` flow, for containers the IDE starts, printed it.

    Re-adding the endpoint was the wrong fix — it would be a second reason for a
    devcontainer to reach Huddle itself, which is what 14 spends a page avoiding.
    The generated override now **bind-mounts** the host CA read-only
    (`~/.huddle/ca/ca.crt` → the `--ca-path` target), the same file the gateway
    gets mounted. The cost is that the path is a host path baked into a generated
    file, so it is regenerated per machine; `huddle migrate` warns when the file
    does not exist yet, because Docker would otherwise silently create a directory
    there.

15. **`--docker-socket` in `huddle migrate` was generated-but-not-served.**
    The per-container filtered socket used to be provisioned only when *Huddle*
    created a container; for an IDE-started compose service nothing pre-created
    `<HOST_SOCKET_DIR>/<container_name>`.

    **Resolved**, by extending the same relay blocker 16 already built rather
    than adding a second mechanism. `containerSnapshot()`'s device list can
    only ever name containers Docker currently reports, which is no good here:
    the whole problem is that the socket has to exist *before* `docker compose
    up` ever starts the container, or the bind mount sees an empty directory
    instead of a live socket. So registration happens at `huddle migrate
    --docker-socket` time, not lazily on first connection like a
    Huddle-created devcontainer's registration in `docker.ts` — there is no
    connection to be lazy about yet. `huddle migrate` now calls
    `POST /api/docker/register-socket` (operator-token, `/api/*`, since this is
    the developer telling Huddle about containers *they* are about to start)
    with every `container_name` that got the socket mount; Node remembers them
    in `socket_registrations` and `buildContainerFeed()` unions them into
    `ContainerFeed.devcontainers` unconditionally — not gated on the container
    running, or existing at all yet. The gateway's `syncSocketRelay()` already
    treats that list as "sockets to serve" with no other precondition, so it
    pre-creates the socket the same poll cycle the registration reaches it. The
    API call does not report success merely after writing that row: it waits for
    the gateway's authenticated `/control/socket-ready` acknowledgement, which
    is sent only after the Unix listener has bound. Therefore a successful
    `huddle migrate` means `docker compose up` finds a live socket instead of an
    empty directory. The flag no longer needs a warning; a registration call
    that fails (Huddle unreachable or gateway not ready) is reported and the
    operator re-runs the command instead.

16. **The Docker socket a devcontainer mounts is created by the gateway.**
    Resolved; recorded here because the first cut of the split got it wrong and
    the reason it was wrong is not obvious.

    `/tmp/dc-sockets/<name>/docker.sock` is a path on the DOCKER ENGINE's host,
    because that is where the bind mount is resolved. Before the split the
    process serving it was the gateway container, which runs on the engine, so
    the two were the same machine by construction. Moving `socket-proxy.ts` to
    Huddle Node broke that silently on every engine that runs in a VM — Docker
    Desktop, Rancher, `podman machine` — where Node would create the socket on
    macOS/Windows and the devcontainer would mount one out of the VM. On Windows
    it did not even get that far: Node's `net` has no AF_UNIX server, so
    `listen('/tmp/dc-sockets/…/docker.sock')` failed with `EACCES` and took
    container creation down with it.

    The two candidate fixes were "serve the sockets over TCP from Node" and
    "keep a socket-serving helper inside the engine". The first does not close:
    a devcontainer needs a *Unix socket*, and its network is `--internal`, so it
    could not reach a TCP port on Node even if it wanted to. So: the gateway
    creates the socket, Node keeps the filter, and each connection is tunnelled
    between them as an HTTP Upgrade on the control port
    (`control/socket-relay-protocol.ts`).

    The control port rather than a new listener, deliberately: it is a port the
    gateway already has a token for, already knows how to reach, and that the
    operator has already had to get through their host firewall once. The
    security shape is unchanged — the gateway forwards bytes and decides
    nothing, and the container name is bound to the socket path by the side that
    accepted the connection, never sent by the caller.
