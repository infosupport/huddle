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
| 4c | **Control channel, read half** — `/control/health`, `/control/policy`, `/control/containers` on Node, behind a token of the gateway's own | `auth.ts` (second token), `api.ts` (guard), new `control/{http,feed,routes}.ts` | none — nothing consumes it yet | `control-http.test.ts` (pure, 15); `control-routes.test.ts` (12, DB-gated) | additive; no existing route changes |
| 4d | **Control channel, write half** — the effect list and audit entries the gateway produces flow back to Node | `control/routes.ts`, proxy-side queue | audit sink | contract tests both sides | additive |
| 4e | **Remote binding** — the facade reads the polled feeds instead of SQLite/Docker | `control/plane.ts` | rule evaluation input | contract tests both sides | feature-flagged; `all` keeps the in-process binding |
| 4e′ | **Self-traffic guard** — one tested predicate instead of the `'huddle'` literal at three proxy sites; loopback refused regardless of policy | new `proxy-self.ts`, `proxy.ts` | none — the sudo-audit exception is preserved | `proxy-self.test.ts` (14, pure) | self-addressed hosts stop appearing as `requested` rules (blocker 14) |
| 5 | **SBX direct exec** (done) — mailbox dropped; `sandbox/ops.ts` execs `sbx` on the host | deleted `bridge/`, `cli/src/sbx-bridge.ts`, `gateway/sbx.sh`, `run-sandbox-mode.sh`, the `/sbx-bridge` mount; new `cli/src/sbx-host.ts` | container→host hop removed | `sbx-host-only.test.ts` (4); existing sbx tests unchanged | sbx now needs `huddle node` — see the gap below |
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

**The gap this opens, stated plainly.** sbx is now usable only where sbx can
actually run: `huddle node` on the host (`HUDDLE_HOST_MODE=1`), or any process
with an explicit `HUDDLE_SBX_BIN`. A gateway container in the default `all`
role can no longer drive sandboxes, and until `huddle init` starts Huddle Node
itself (step 6) that is the configuration most users are in. This is a
deliberate regression in reach, not an accident: keeping the mailbox alive
until step 6 would have been keeping it for backwards compatibility, which the
task rules out. `ops.unavailableReason()` makes the failure legible — the old
path would have reported `'sbx' not found on PATH`, which reads as a missing
install and sends people off to reinstall Docker Sandboxes.

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

13. **The two halves cannot reach each other without widening a bind address.**
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

14. **Devcontainers are allowed to reach Huddle's own API — through the proxy.**
    The proxy refuses self-addressed traffic at all three entry points (plain
    HTTP, WebSocket upgrade, CONNECT), but the plain-HTTP site carries one
    deliberate exception: `POST :3000/api/audit/sudo`, the ingest devcontainers
    use to report sudo invocations. It is public by design (`devcontainerPublicApi`
    in `api.ts`) and it must keep working.

    That is a data-plane→control-plane dependency the split has to carry across:
    after the move, the endpoint no longer lives in the gateway's own process. The
    gateway will have to forward that one request to Node on the host, over
    whatever transport blocker 13 settles on — which makes it the same listener
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

    Still open, and dependent on 13: the host-mode names for the same guard
    (`host.docker.internal`, the bridge address, Node's host port). They cannot be
    pinned down before the transport is chosen, so they are named here rather than
    guessed at in code.
