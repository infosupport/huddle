# Splitting Huddle Node from Huddle Gateway

Status: **proposed** — investigation + migration plan, first step implemented.
Branch: `feat/sbx-sandboxes-rebased` (rebased onto `feat/69-export-import-rules-rebased`).

---

## 1. Current state

### 1.1 How Huddle starts today

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

Everything else — `huddle start`, `huddle firewall …`, `huddle indexfolder`,
`huddle sbx …` — is an HTTP client against `http://localhost:3000` with the
operator token from `~/.huddle/config.json` (`cli/src/api.ts`).
`huddle restart` = `runInit` again. There is no `huddle stop`.

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

## 2. Target state

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
              └── gateway control plane ───────┐
                                               │  policy push / event pull
                                               ▼
   devcontainer ──▶ huddle-gateway (Docker: proxy :80, sbx proxy :32768) ──▶ network
```

Trust boundaries improve rather than weaken:

* Huddle Node is trusted host software — no longer reachable from
  `devcontainer-net` at all, so the control plane leaves the sandbox's blast
  radius entirely.
* The gateway keeps `--internal` + in-container iptables **unchanged**.
* The gateway no longer needs `/var/run/docker.sock`, which removes a
  container-escape primitive from the network-exposed component.

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
| 4c | **Gateway control channel** — authenticated REST surface (`/control/policy`, `/control/containers`, `/control/events`) + a remote binding for the facade | `gateway/src/control/*`, `cli`/Node push side | rule evaluation input, audit sink | contract tests both sides | feature-flagged; `all` keeps the in-process binding |
| 5 | **SBX direct exec** — drop the mailbox; `sandbox/ops.ts` execs `sbx` on the host | `sandbox/ops.ts`, delete `bridge/`, `cli/src/sbx-bridge.ts`, the `/sbx-bridge` mount | container→host hop removed | existing `sbx-*.test.ts` keep passing | only lands after step 3 works |
| 6 | **`huddle init` starts both** — gateway container + Huddle Node, health-checked | `cli/src/init.ts` | container startup responsibilities → CLI | init integration test | keep `--gateway-only` escape hatch |
| 7 | **Slim the gateway** — drop the Docker socket mount, `docker.ts`/`api.ts`/extensions from the image | `gateway/Dockerfile`, split sources | — | e2e firewall suite | last step, most reversible in isolation |

**Compatibility rule for steps 1–5:** `HUDDLE_ROLE` defaults to `all` and every
default path/port keeps its current value, so an unmodified `huddle init` on an
unmodified image behaves exactly as before.

---

## 4. SBX migration — KEEP vs REMOVE

### KEEP (domain + process management, host-agnostic)

```
gateway/src/sandbox/protocol.ts    types + name/target validation
gateway/src/sandbox/ops.ts         execFile passthrough, output parsers   ← keep, retarget
gateway/src/sandbox/projection.ts  Huddle rules → sbx policy (pure)
gateway/src/sandbox/reconcile.ts   diff + apply
gateway/src/sandbox/registry.ts    known-sandbox cache for the fleet merge
gateway/src/sandbox/auto-sync.ts   debounced reconcile + policy-log ingest
gateway/src/sbx.ts                 facade: startSandbox/trustCa/…
cli/src/sbx-host-ca.ts             host CA trust (already host-native)
```

The `:32768` sbx egress proxy **stays in the gateway container** — sandbox
traffic must keep crossing the enforcement point.

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

---

## 5. Node ↔ Gateway control plane

Deliberately **not** a generic host bridge. Three concrete needs, one small
authenticated HTTP surface on the gateway (reachable from the host, never from
`devcontainer-net`):

| Need | Shape |
| --- | --- |
| push firewall policy | `PUT /control/policy` — full snapshot, versioned, idempotent |
| push the IP→container map | `PUT /control/containers` — removes the proxy's need for the Docker socket |
| receive blocked/pending events | `GET /control/events` (SSE) — feeds `requested` rows |
| health | `GET /control/health` |

Snapshot-not-delta keeps it idempotent and self-healing, matching the existing
`reconcile()` philosophy. Authenticated with the same operator token.

---

## 6. Open questions for the CLI lifecycle

Answered by inspection, to be confirmed in step 3/6:

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
  engine socket. The npipe case on Windows needs verifying in step 6.

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

### Found while implementing steps 1–3

6. **Huddle Node has no delivery mechanism.** `huddle node` can *run* a build but
   nothing *ships* one. The published CLI is `files: ["dist"]` with zero runtime
   dependencies; Huddle Node needs fastify, dockerode and `better-sqlite3` — a
   native module requiring per-platform prebuilds (win32/darwin/linux × x64/arm64).
   **Decided: bundle the gateway build into the CLI package.** One package, one
   version, no version skew between the CLI and the Huddle Node it starts, and
   npm resolves the right `better-sqlite3` prebuild for the host platform at
   install time. The CLI package gets substantially larger, which is the price.

   The two rejected alternatives, and why:
   - *A second `@infosupport/huddle-node` package* — thinner CLI, but two
     packages that can drift out of sync. Real operational cost for no gain
     while everyone who runs Huddle needs both halves anyway.
   - *`docker cp` the build out of the gateway image* — **not viable.** The
     image is Linux/amd64; copying its `node_modules` onto a Windows or macOS
     host yields a `better-sqlite3` binary that cannot load. This is not
     hypothetical: the gateway `node_modules` in the dev container already fails
     with `invalid ELF header` for exactly this reason, which is why 10 test
     files skip. Only npm (or a per-host rebuild) gets the native module right.

   **This blocks step 6**, not step 3 or 4.
7. **The resolv.conf seam.** `initContainerNetworks()` is a Docker call (Node),
   but the `/etc/resolv.conf` it corrupts belongs to the *gateway* container
   (`dns-egress.ts`). In one process those chain directly. Split, Node performs
   the connect and the gateway has to notice by itself — currently via the
   settling re-runs `scheduleSettlingSanitize()` already schedules. That works,
   but it is timing-based, not event-driven; `/control/events` (step 4) is the
   place to make it explicit.
8. **`initDb()` and `initCa()` run in both roles.** Neither is cleanly one-sided
   yet: the proxy still reads rules and writes audit rows from SQLite, and the CA
   is signed by the gateway but distributed by Node. A split deployment must
   therefore share `DB_PATH` and `CA_DIR` today. Step 4 removes the DB half; the
   CA half stays and needs the read-only mount from blocker 3.
9. **The CLI has no test harness.** `cli/package.json` has no `test` script and no
   test runner, so the arg-parsing and entry-resolution logic added in step 3 is
   verified only by running the built CLI. Adding vitest needs a `registry.npmjs.org`
   install, which the Huddle firewall blocks in this devcontainer.
11. **`checkRule` is not a read — it writes, and it mints ids.** This is the
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

12. **`index.ts` and `proxy.ts` are the only CRLF files in the repo** (also on
    `main`). With `core.autocrlf=input` — the setting in this devcontainer — any
    edit normalizes them and turns a two-line change into a ~2000-line diff that
    conflicts with every concurrent branch. Steps 1–2 preserved CRLF via
    `git -c core.autocrlf=false add`. Normalizing both files to LF is worth doing,
    but as its own commit, on a quiet branch point.
