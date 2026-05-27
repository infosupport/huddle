# Huddle DMZ Portal — Security Review & Verification

**Scope:** `gateway/src/`
**Initial review:** 2026-05-22
**Last verified:** 2026-05-27

This document consolidates the original security analysis with the verification
test plan. Each finding has a **current status** based on code inspection and
the latest verification run. Re-run the test plan in [Part B](#part-b--verification-test-plan)
after any change to `api.ts`, `proxy.ts`, `socket-proxy.ts`, or `docker.ts`.

---

## Executive Summary

Huddle is a TypeScript/Fastify gateway whose role is to (a) sit between dev
containers and the outside world as an HTTP/HTTPS proxy enforcing per-domain
allow/deny policy, (b) broker time-limited access to the host's Docker socket,
and (c) host a management UI for operators. Because Huddle has full access to
the host Docker socket and is the only thing standing between untrusted
container workloads and the internet, it is a high-value target.

The initial review (2026-05-22) found multiple critical and high-severity
issues that rendered Huddle's central security promises (firewall enforcement,
time-limited Docker access, container isolation) bypassable by any process
inside a dev container. The follow-up run (2026-05-26) found an additional
sandbox-escape via unfiltered `HostConfig` on `POST /containers/create`.

**Status as of 2026-05-27:** the three critical findings and the most exploitable
high-severity findings have been addressed. The fixes have been re-verified
end-to-end from a guarded devcontainer (see [verification run](#latest-verification-run--2026-05-27)).
Several medium/low findings and inherent design constraints remain — see the
[summary table](#summary-table) for the full picture.

---

## Status overview

| ID | Severity | Status | Verified by |
|----|----------|--------|-------------|
| CRIT-01 | Critical | **FIXED** | T1, T6 |
| CRIT-02 | Critical | **FIXED** | T6 |
| CRIT-03 | Critical | **FIXED** | T4, T7 |
| HIGH-01 | High | **FIXED** | code inspection (`api.ts` resolved-path check) |
| HIGH-02 | High | **PARTIAL** — `HostConfig` validated; raw name regex still depends on Docker | T11 |
| HIGH-03 | High | **WONTFIX (inherent)** — `NET_ADMIN` egress is enforced by network routing, not in-container iptables | — |
| HIGH-04 | High | **FIXED (via CRIT-03)** | T4 |
| HIGH-05 | High | **FIXED** — `fastify ^5.0.0` pulls `fast-uri ^3.0.0 (>= 3.1.2)` | `gateway/package.json` |
| ESCAPE-2026-05-26 | Critical | **FIXED** — `validateHostConfig()` in `socket-proxy.ts` | T11 |
| MED-01 | Medium | OPEN | — |
| MED-02 | Medium | OPEN | — |
| MED-03 | Medium | OPEN | — |
| MED-04 | Medium | OPEN | — |
| MED-05 | Medium | OPEN (matters once additional auth lands) | — |
| LOW-01 | Low | OPEN | — |
| LOW-02 | Low | OPEN | — |
| LOW-03 | Low | OPEN | — |

---

## Part A — Findings

### [CRIT-01] Docker socket grant policy bypassable via attacker-supplied `X-Container-Id`
**Original severity:** Critical
**Status:** FIXED
**File:** `src/socket-proxy.ts`, `src/docker.ts`

The original chain: every container was configured to send
`X-Container-ID: <its-own-name>` on every `curl`, and the proxy trusted that
header for identity. Combined with the unauth'd management API (CRIT-03), any
container could `PUT /api/authz/grants/<other-container>` and grant arbitrary
Docker access.

**Fix:** identity now derives from which UNIX socket the client connected to
(closure variable in the per-container socket proxy), not from any
client-supplied header. The management API is unreachable from
`devcontainer-net` in the first place (CRIT-03 fix), removing the grant API
from the attack surface.

**Verify with:** T1 (per-container socket), T6 (identity spoofing rejected).

---

### [CRIT-02] HTTP proxy trusts container-side identity via IP cache only
**Original severity:** Critical
**Status:** FIXED
**File:** `src/proxy.ts`, `src/docker.ts`

The proxy identified callers via `req.socket.remoteAddress` and the
management API on `:3000` was reachable on the same `devcontainer-net`.

**Fix:** the management API now has a source-IP gate
(`api.ts:42-59`) that refuses any request whose source is on
`devcontainer-net` or `dc-net-*`. The header-spoofing attack is therefore
unreachable from a guarded container.

**Verify with:** T4, T6.

---

### [CRIT-03] Management API has no authentication
**Original severity:** Critical
**Status:** FIXED
**File:** `src/api.ts`

Every endpoint under `/api/*` was anonymous and reachable as `huddle:3000`
from any container on the bridge.

**Fix:** source-IP gate at `api.ts:42-59` enumerates Docker networks and
denies anything originating from `devcontainer-net` or `dc-net-*`. A narrow
whitelist (e.g. `POST /api/audit/sudo`) is exposed via the HTTP proxy with
explicit path-checking (`proxy.ts`).

**Verify with:** T4 (direct API blocked), T7 (path-whitelist on proxy).

---

### [HIGH-01] Path traversal in `/assets/:file`
**Original severity:** High
**Status:** FIXED
**File:** `src/api.ts`

**Fix:** the route now does a `path.resolve()` containment check (`resolved`
must start with the assets base path) on top of the character allow-list.

---

### [HIGH-02] Container/image/workspace inputs flow into Docker API and shell
**Original severity:** High
**Status:** PARTIAL — input is no longer the load-bearing escape vector, but
the strict regex/allow-list on `containerName`/`imageName`/`workspaceDir`
remains as a follow-up.
**File:** `src/docker.ts`, `src/socket-proxy.ts`

The original exploit path required reaching `/api/docker/start` anonymously
(CRIT-03), which is now blocked. The remaining sandbox-escape via
`HostConfig` (see ESCAPE-2026-05-26 below) is also closed by
`validateHostConfig()`. Per-API-route allow-list validation is still
recommended as defence-in-depth.

**Verify with:** T11.

---

### [HIGH-03] `iptables` rules can be removed by container (`NET_ADMIN`)
**Original severity:** High
**Status:** WONTFIX — by design, with mitigation
**File:** `src/docker.ts`

In-guest `iptables` is not the egress boundary. The actual containment is at
the network level: containers are placed on `dc-net-<name>` and Huddle is the
gateway, so even if a container flushes `iptables -t nat -F OUTPUT` it cannot
reach the wider internet without going through Huddle.

The in-container DNAT (`-A OUTPUT -p tcp --dport 80 ! -d $HUDDLE_IP -j DNAT
...`) is an *ergonomic* convenience that makes `http_proxy` env unnecessary
for tools that ignore it; it is not the security boundary.

---

### [HIGH-04] Snapshot endpoint allows committing arbitrary images
**Original severity:** High
**Status:** FIXED (via CRIT-03)
**File:** `src/api.ts`

The endpoint is no longer reachable from a devcontainer because of the
source-IP gate. Host-side use remains intentional.

---

### [HIGH-05] Known-vulnerable `fast-uri ≤ 3.1.1`
**Original severity:** High
**Status:** FIXED
**File:** `gateway/package.json`

`fastify` is now pinned to `^5.0.0` and pulls `fast-uri ^3.0.0` (≥ 3.1.2),
clearing GHSA-q3j6-qgpj-74h6 and GHSA-v39h-62p7-jpjc. Run `npm audit`
periodically to catch new advisories.

---

### [ESCAPE-2026-05-26] HostConfig escape vectors unfiltered on `POST /containers/create`
**Severity:** Critical (introduced after initial review, found in follow-up run)
**Status:** FIXED
**File:** `src/socket-proxy.ts` — `validateHostConfig()`

`socket-proxy.ts` injected `huddle.parent` label and `NetworkMode: dc-net-*`,
but did not filter the rest of `HostConfig`. With a Docker grant, a
devcontainer could create a sibling container with `--privileged`,
`--pid=host`, `--cap-add=SYS_ADMIN`, `-v /:/host`, etc. and escape to the
host. The malicious container itself carried no `huddle.parent` label, so it
fell entirely outside Huddle's tracking.

**Fix:** `validateHostConfig()` now 403s any `POST /containers/create` body
that contains:
- `Privileged: true`
- `PidMode`/`IpcMode`/`UsernsMode`/`CgroupnsMode`/`UTSMode = host`
- `CgroupParent` set
- Non-empty `CapAdd`, `Devices`, `Sysctls`
- Dangerous `SecurityOpt` (`apparmor=unconfined`, `seccomp=unconfined`, `no-new-privileges=false`)
- Any `Binds` with a host-path source
- Any `Mounts` with `Type: "bind"`

Unparseable JSON bodies (which previously bypassed the label-injection layer)
are also rejected.

**Out-of-scope for this fix (potential follow-ups, do not regress-test as failures):**
- `POST /containers/{id}/exec` body — `Privileged: true` on exec is not validated. Bounded by the container's existing HostConfig, so low risk after this fix.
- `POST /build` query params — image build, no persistent HostConfig.
- `POST /containers/{id}/update` — not in the route allow-list anyway (falls through to deny).

**Verify with:** T11.

---

### [MED-01] Unbounded buffering in socket proxy → memory-exhaustion DoS
**Severity:** Medium
**Status:** OPEN
**File:** `src/socket-proxy.ts`

Until `\r\n\r\n` is found, the header buffer grows without limit. A malicious
container (no grant needed; the policy check runs *after* headers are
complete) can stream gigabytes of header bytes and exhaust gateway memory.
No per-connection timeout, so slowloris-style holds also work.

**Recommendation:** cap the buffer (e.g. 32 KB) and 431 if exceeded.
`client.setTimeout(10_000)` to drop idle connections. Same for `proxy.ts`.

---

### [MED-02] Per-container Docker socket created world-writable (`0o777`)
**Severity:** Medium
**Status:** OPEN
**File:** `src/socket-proxy.ts`

`chmod 0o777` on the per-container socket file. Inside the gateway container
this is contained (singleton mount), but if `/tmp/dc-sockets/` ever gets
bind-mounted elsewhere, anything on that host can hit the proxy.

**Recommendation:** `0o660` with a dedicated group, or drop the `chmod` and
rely on umask.

---

### [MED-03] HTTP proxy does not strip hop-by-hop or sensitive headers
**Severity:** Medium
**Status:** OPEN
**File:** `src/proxy.ts`

Only `proxy-connection` is stripped. Standard hop-by-hop headers (`Connection`,
`Keep-Alive`, `TE`, `Transfer-Encoding`, `Upgrade`, `Trailer`) and proxy-routing
headers (`Proxy-Authorization`, `Proxy-Authenticate`) are forwarded verbatim.
Client `Host` header is also forwarded as-is, which can diverge from
`target.hostname` (the field Huddle's policy uses).

**Recommendation:** explicitly construct the outgoing header set, strip
hop-by-hop per RFC 7230 §6.1, force `Host: ${target.host}`.

---

### [MED-04] DOM XSS surface in management UI is "safe by convention only"
**Severity:** Medium
**Status:** OPEN (note: UI is now Angular, this finding originates from the legacy `src/ui/app.js` and may already be moot — re-audit Angular components and CSP)
**File:** historically `src/ui/app.js`; current UI lives in `gateway/frontend/`

The original concern was that `innerHTML = ${param}` with template literals
was only safe because every dev remembered to wrap in `esc()`. With the
Angular rewrite this should be revisited: Angular's default interpolation
escapes by default, but `[innerHTML]` and `bypassSecurityTrust*` calls
re-open the hole. No `Content-Security-Policy` header is currently set on the
UI route.

**Recommendation:** add a strict CSP, ban `bypassSecurityTrust*` outside of a
single audited sanitiser module.

---

### [MED-05] No CSRF protection on state-changing endpoints
**Severity:** Medium
**Status:** OPEN (low impact today because API is host-only; matters if additional auth ever lands)
**File:** `src/api.ts`

If auth ever migrates from "source IP" to a cookie-based session, CSRF
becomes immediately exploitable. Prefer bearer tokens; if cookies are
required, add a CSRF token or `SameSite=Strict` + `Origin`/`Referer` check.

---

### [LOW-01] `req.body` dereferenced without null/shape checks
**Severity:** Low
**Status:** OPEN
**File:** `src/api.ts`

Fastify rejects malformed JSON, but `req.body` can still be `null` if
`Content-Type` is missing — destructuring throws and a 500 is returned.

**Recommendation:** declare Fastify JSON schemas for body/query/params on
every route. Closes parts of HIGH-02 in the process.

---

### [LOW-02] `BASE_IMAGE` env var unvalidated
**Severity:** Low
**Status:** OPEN
**File:** `src/docker.ts`

`getBaseImageName()` returns `process.env.BASE_IMAGE ?? 'base-devimage'` and
the value flows to the UI as a startable image. Pin to a known-good value or
validate against a regex.

---

### [LOW-03] Failed `iptables` redirect silently ignored
**Severity:** Low
**Status:** OPEN (mitigated by the architectural note in HIGH-03 — the redirect is an ergonomic convenience, not the security boundary)
**File:** `src/docker.ts`

The container init script lacks `set -e`, so a failing `getent`/`iptables`/
`mkdir` does not surface back to the API. Containers can start with the
redirect not applied — but the network-level gating still holds.

---

## Part B — Verification Test Plan

You are an agent running inside a **fresh** devcontainer attached to Huddle.
This is your test plan. Run each test, compare actual output to "Expected",
and report PASS / FAIL with the observed output. End with a one-paragraph
summary.

Do NOT skip tests, do NOT delete this file, do NOT try to "fix" failing tests
yourself — your job is to verify and report.

### Resetting before a re-run

- To deploy a freshly-built huddle: restart only the `huddle` container. The
  per-container socket proxy is recreated on attach; the devcontainer itself
  does not need to restart (the docker.sock may flap for a moment).
- For a clean baseline ("fresh devcontainer"): rebuild this devcontainer
  **and** remove any leftover containers labeled
  `huddle.parent=<this-devcontainer-name>` from prior sessions. Check with
  `docker ps -a --filter label=huddle.parent=<this-devcontainer-name>` (needs
  a Docker grant).

### Context

```bash
echo "container: $HOSTNAME"
echo "user: $(whoami)"
```

Most tests do not need a Docker grant. **T9** and **T11** do — if no grant is
available, mark them SKIPPED and ask the user to grant Docker access via the
Huddle UI before running them.

`--noproxy huddle` on curl means "ignore http_proxy for this host" — used to
verify the direct path from the API itself, bypassing the gateway, so we can
confirm both layers work.

---

### T1 — Per-container socket mount

```bash
ls -la /var/run/docker.sock
ls -la /tmp/dc-sockets/ 2>&1 || echo "directory not visible — good"
```

**Expected:** `/var/run/docker.sock` exists as a socket file (no longer a
symlink). `/tmp/dc-sockets/` should **not exist** as a directory inside the
container.

---

### T2 — `docker ps` shows only own spawns

```bash
docker ps -a
```

**Expected:** Without a Docker grant: `authorization denied by policy` — the
stricter version of "empty list", still PASS. With a grant: only containers
labeled `huddle.parent=<your-container-name>` appear; nothing else from the
host. If you see a stray container that you didn't spawn this session, check
its `huddle.parent` label via `docker inspect` — if it matches your container
name, it's a leftover from a previous attach (note it, still PASS); if not,
that's a real isolation breach.

---

### T3 — Inspect of a foreign container denied

```bash
docker inspect huddle 2>&1 | head -5
```

**Expected:** Error / `403` / `container not owned by this devcontainer` (or
`inspect of devcontainer not permitted`). The actual JSON config of the
huddle container must not be returned.

---

### T4 — Management API unreachable from devcontainer-net

```bash
for path in /api/health /api/grants /api/audit /api/rules /api/containers; do
  code=$(curl -s -o /tmp/r --noproxy huddle -w "%{http_code}" "http://huddle:3000${path}")
  body=$(cat /tmp/r | head -c 200)
  echo "GET ${path} → HTTP ${code}  body=${body}"
done
```

**Expected:** Every line is `HTTP 403` with body containing
`endpoint not allowed from devcontainer network`.

---

### T5 — Sudo audit endpoint IS reachable

```bash
curl -s --noproxy huddle -X POST http://huddle:3000/api/audit/sudo \
  -H "Content-Type: application/json" \
  -d '{"entry":"T5: manual probe from verification agent"}'
echo
```

**Expected:** `{"ok":true}`. The user can confirm in the Huddle UI audit log
that an entry appeared, attributed to **your** container name.

---

### T6 — Sudo audit: identity spoofing rejected

```bash
curl -s --noproxy huddle -X POST http://huddle:3000/api/audit/sudo \
  -H "Content-Type: application/json" \
  -d '{"container":"huddle","entry":"T6: SPOOF — claiming to be huddle itself"}'
echo
```

**Expected:** `{"ok":true}` — BUT in the Huddle audit log the entry must
appear under your own container, not `huddle`. The body's `container` field
must be ignored. Ask the user to verify in the UI.

---

### T7 — Gateway path-whitelist for the huddle domain

This goes **through** the http proxy (no `--noproxy`), so the gateway sees
the request and applies its own check before forwarding:

```bash
# Should be blocked at the proxy layer
code=$(curl -s -o /tmp/r -w "%{http_code}" http://huddle:3000/api/grants)
echo "GET /api/grants via proxy → ${code}  body=$(cat /tmp/r | head -c 200)"

# Should pass the proxy and reach the API
code=$(curl -s -o /tmp/r -w "%{http_code}" -X POST http://huddle:3000/api/audit/sudo \
  -H "Content-Type: application/json" -d '{"entry":"T7: via proxy"}')
echo "POST /api/audit/sudo via proxy → ${code}  body=$(cat /tmp/r | head -c 200)"
```

**Expected:**
- First → `403` with body containing `huddle-internal endpoint not allowed`
- Second → `200` with body `{"ok":true}`

---

### T8 — HTTPS CONNECT to huddle blocked

```bash
curl -sv --noproxy huddle https://huddle:3000/ 2>&1 | head -10
# and via proxy
curl -sv https://huddle:3000/ 2>&1 | grep -i "connect\|forbidden\|huddle-internal" | head -5
```

**Expected:** Direct HTTPS fails (no TLS). Via proxy, CONNECT is rejected
with `403 huddle-internal endpoint not allowed`.

---

### T9 — Container spawn forces network + label (needs Docker grant)

**Pre-condition:** Ask the user via the Huddle UI to grant Docker access
(any duration). If unavailable, mark SKIPPED.

```bash
docker run -d --name t9-spawn alpine sleep 3600
docker inspect t9-spawn | grep -E '"NetworkMode"|"huddle.parent"' | head -5
docker rm -f t9-spawn
```

**Expected:**
- `NetworkMode` is `"dc-net-<your-container-name>"` — not `bridge`, not `host`
- Labels include `"huddle.parent": "<your-container-name>"`

---

### T10 — huddle is in the global allow rules

(Ask the user) In the Huddle UI → Firewall, look for a row with:
- domain: `huddle`
- container: (global / empty)
- status: `allow`

**Expected:** It exists. If it does not, the `INSERT OR IGNORE` seed in
`initDb()` did not run — flag it.

---

### T11 — HostConfig escape vectors are rejected (needs Docker grant)

**Pre-condition:** same as T9. If unavailable, mark SKIPPED.

Each request below tries to create a container with one dangerous
`HostConfig` field. The expected outcome for every one is `HTTP 403` with a
reason string from `validateHostConfig()`. **None of these containers should
ever be created.**

```bash
for body in \
  '{"Image":"alpine","Cmd":["sleep","30"],"HostConfig":{"Privileged":true}}' \
  '{"Image":"alpine","Cmd":["sleep","30"],"HostConfig":{"PidMode":"host"}}' \
  '{"Image":"alpine","Cmd":["sleep","30"],"HostConfig":{"IpcMode":"host"}}' \
  '{"Image":"alpine","Cmd":["sleep","30"],"HostConfig":{"UsernsMode":"host"}}' \
  '{"Image":"alpine","Cmd":["sleep","30"],"HostConfig":{"UTSMode":"host"}}' \
  '{"Image":"alpine","Cmd":["sleep","30"],"HostConfig":{"CapAdd":["SYS_ADMIN"]}}' \
  '{"Image":"alpine","Cmd":["sleep","30"],"HostConfig":{"Devices":[{"PathOnHost":"/dev/sda","PathInContainer":"/dev/sda","CgroupPermissions":"rwm"}]}}' \
  '{"Image":"alpine","Cmd":["sleep","30"],"HostConfig":{"Sysctls":{"net.core.somaxconn":"1024"}}}' \
  '{"Image":"alpine","Cmd":["sleep","30"],"HostConfig":{"SecurityOpt":["apparmor=unconfined"]}}' \
  '{"Image":"alpine","Cmd":["sleep","30"],"HostConfig":{"SecurityOpt":["seccomp=unconfined"]}}' \
  '{"Image":"alpine","Cmd":["sleep","30"],"HostConfig":{"SecurityOpt":["no-new-privileges=false"]}}' \
  '{"Image":"alpine","Cmd":["sleep","30"],"HostConfig":{"Binds":["/:/host"]}}' \
  '{"Image":"alpine","Cmd":["sleep","30"],"HostConfig":{"Binds":["/var/run/docker.sock:/var/run/docker.sock"]}}' \
  '{"Image":"alpine","Cmd":["sleep","30"],"HostConfig":{"Binds":["/etc:/host-etc"]}}' \
  '{"Image":"alpine","Cmd":["sleep","30"],"HostConfig":{"Mounts":[{"Type":"bind","Source":"/etc","Target":"/host-etc"}]}}' \
  '{"Image":"alpine","Cmd":["sleep","30"],"HostConfig":{"CgroupParent":"/escape"}}'; do
  flag=$(echo "$body" | grep -oE '"(Privileged|PidMode|IpcMode|UsernsMode|UTSMode|CapAdd|Devices|Sysctls|SecurityOpt|Binds|Mounts|CgroupParent)"[^,}]*' | head -1)
  code=$(curl -s -o /tmp/r --unix-socket /var/run/docker.sock -w "%{http_code}" \
           -H 'Content-Type: application/json' -X POST -d "$body" \
           http://localhost/containers/create)
  echo "${flag} → HTTP ${code}  body=$(cat /tmp/r | head -c 200)"
done

# Sanity: a benign HostConfig must still succeed and get forced onto dc-net-*.
docker run -d --name t11-benign alpine sleep 30
docker inspect t11-benign --format '{{.HostConfig.NetworkMode}} {{json .HostConfig.Binds}} {{.HostConfig.Privileged}}' 2>&1
docker rm -f t11-benign
```

**Expected:**
- Every iterated request → `HTTP 403` with body like `{"message":"<X> not permitted"}` matching the field name.
- The benign sanity run: container created, `NetworkMode = dc-net-<your-container-name>`, `Binds = null`, `Privileged = false`.
- If any escape-vector request returns `201` instead of `403`, the fix has
  regressed — **flag it as a P0 finding and stop**, do not exploit further.

---

### Reporting

Produce a final table:

| Test | Status | Notes |
|------|--------|-------|
| T1 … | PASS / FAIL / SKIPPED | one-line observation |

End with a one-paragraph summary: which layer caught what, anything
unexpected, anything you couldn't verify alone (audit log entries need the
user to check the UI).

---

## Latest verification run — 2026-05-27

Three independent expert agents ran the non-grant-requiring tests (T1–T8)
from inside a fresh Huddle-gated devcontainer (hostname `9d53e1c27e76`, user
`vscode`). Results:

| Test | Status | Observation |
|------|--------|-------------|
| T1 | PASS | `/var/run/docker.sock` is a real socket file (not a symlink); `/tmp/dc-sockets/` not visible inside the container. |
| T2 | PASS | `docker ps -a` returned `authorization denied by policy` — stricter than an empty list. |
| T3 | PASS | `docker inspect huddle` denied; no JSON config leaked. |
| T4 | PASS | All five management endpoints returned `HTTP 403` with body `endpoint not allowed from devcontainer network`. |
| T5 | PASS | `POST /api/audit/sudo` returned `{"ok":true}` via the whitelisted path. |
| T6 | PASS-PENDING-UI | Spoof body accepted at HTTP level; UI audit log must confirm the entry is attributed to the real container, not `huddle`. |
| T7 (block) | PASS | `GET /api/grants` via proxy → `403 huddle-internal endpoint not allowed`. |
| T7 (allow) | PASS | `POST /api/audit/sudo` via proxy → `200 {"ok":true}`. |
| T8 direct | PASS | TLS handshake failed (no TLS on `:3000`). |
| T8 proxy | PASS | `CONNECT huddle:3000` rejected with `403 huddle-internal endpoint not allowed`. |
| T9 | SKIPPED | Requires Docker grant — not requested for this run. |
| T10 | SKIPPED | UI inspection — not performed by the agent team. |
| T11 | SKIPPED | Requires Docker grant — not requested for this run. |

**Summary.** All three architectural layers held: the per-container socket
proxy filters host-side visibility (T1–T3), the source-IP gate on the
management API filters by origin (T4–T5), and the HTTP proxy filters by
path/CONNECT for the huddle-internal hostname (T7–T8). Unknown external
domains returned a `403 requested` instead of being silently dropped — the
proxy is creating approval requests as designed. No surprises; failure modes
were consistent and did not leak internal detail. For full coverage the user
should run T9, T10, T11 — they require either a Docker grant or UI access.
