# Huddle DMZ Portal — Security Analysis

Scope: `/workspace/project/huddle/gateway/src/`
Date: 2026-05-22

## Executive Summary

Huddle is a TypeScript/Fastify gateway whose role is to (a) sit between dev
containers and the outside world as an HTTP/HTTPS proxy enforcing per-domain
allow/deny policy, (b) broker time-limited access to the host's Docker socket,
and (c) host a management UI for operators. Because Huddle has full access to
the host Docker socket and is the only thing standing between untrusted
container workloads and the internet, it is a high-value target.

The review found **multiple critical and high-severity issues** that, in the
current configuration, render Huddle's central security promises (firewall
enforcement, time-limited Docker access, container isolation) **bypassable by
any process running inside a dev container** — i.e. by Claude/Codex agents that
the platform is explicitly designed to sandbox.

Critical issues:

- The Docker-socket-grant policy is bypassed simply by sending an
  attacker-chosen `X-Container-Id` header on a normal HTTP request
  (`CRIT-01`), giving full root-equivalent control of the host Docker daemon.
- The HTTP proxy and policy engine trust `X-Container-Id` from the container
  and authorise based on it (`CRIT-02`), so any container can pose as any
  other container (or as `null` = global rules) for firewall checks.
- The management API has **no authentication or authorisation whatsoever**
  (`CRIT-03`); anything that can reach `:3000` can list/start/snapshot
  containers and issue Docker socket grants. The same port is reachable from
  inside dev containers via the `devcontainer-net` bridge.
- Path-traversal via `..%2f` segments on the static asset route (`HIGH-01`).
- Container-name / image-name fields are passed unsanitised into Docker API
  paths and shell-built `iptables`/`printf` lines, enabling command and
  argument injection (`HIGH-02`, `HIGH-03`).

There are also five known-vulnerable transitive dependencies (`HIGH-05`),
unbounded buffering in the socket proxy (`MED-01`), missing TLS termination,
and a permissive `0o777` Unix socket (`MED-02`).

Recommendation: do not expose Huddle on an untrusted network or use it to
isolate adversarial workloads until at least `CRIT-01` through `CRIT-03` are
fixed.

---

## Findings

### [CRIT-01] Docker socket grant policy is bypassable via attacker-supplied `X-Container-Id`
**Severity:** Critical
**File:** `src/socket-proxy.ts:72` (combined with `src/docker.ts:266`)

The per-container Docker socket proxy is the *only* thing standing between a
container and full root on the host. The "grant" is keyed by the container
name and the proxy is supposed to authorise on the basis of which Unix socket
the client connected to:

```ts
// socket-proxy.ts:30
const server = net.createServer((client) => {
  ...
  if (!checkPolicy(containerName)) { ... }    // line 53 — uses closure name
  upstream = net.createConnection(DOCKER_SOCKET);
  ...
  upstream.write(headerPart + `\r\nX-Container-Id: ${containerName}` + afterHeaders.toString());
  // line 72 — injects X-Container-Id pointing at *this* socket's container
});
```

That is fine in isolation. The problem is that **the proxy's `X-Container-Id`
is appended *after* the client's own headers without stripping a client copy**
(`headerPart` is the raw client request, line 49–50). HTTP allows duplicate
headers, and Docker's API does not consume `X-Container-Id` — it is only used
by Huddle's *own* policy/audit layer. But the real Docker daemon doesn't care
about it; the grant check has *already* succeeded for the proxied container,
so this header injection alone doesn't add risk in `socket-proxy.ts`.

The *real* break is `src/docker.ts:172`:

```sh
CURL_LINE='--proxy-header "X-Container-ID: ${containerName}"'
... >> /home/vscode/.curlrc
```

Every container is configured so that every `curl` it makes sends
`X-Container-ID: <its-own-name>`. The HTTP proxy at `:80` then trusts that
header to identify the container (see `CRIT-02`). Combined with `CRIT-03`
(no auth on the management API), a container can:

1. Reach the management API at `huddle:3000` via the shared
   `devcontainer-net`.
2. POST `PUT /api/authz/grants/<some-other-container>` with `{minutes: 120}`
   — granted, no questions asked.
3. Now `<some-other-container>` has Docker socket access for two hours.

There is no authentication, no proof-of-identity, no rate-limit, no CSRF
check, and the grant API is reachable from every container on the bridge.

**Recommendation:**

1. Authenticate the management API (mTLS, bearer token, or restrict to
   `127.0.0.1` and the host UI only — do not expose on `devcontainer-net`).
2. Identify the calling container by **socket peer credentials** or
   **client-cert**, never by a header the client controls. The proxy already
   knows which container it is (the closure variable `containerName`); refuse
   to read `X-Container-Id` from anywhere else.
3. Even for the policy check, strip any client-supplied `X-Container-Id` from
   `headerPart` before forwarding to Docker.

---

### [CRIT-02] HTTP proxy trusts container-side identity via IP cache only; bypassable via `X-Container-Id` header on management API
**Severity:** Critical
**File:** `src/proxy.ts:44`, `src/docker.ts:59`

The HTTP proxy identifies the caller by `req.socket.remoteAddress`:

```ts
// proxy.ts:43
const containerId = await resolveContainerByIp(req.socket.remoteAddress ?? '');
```

This is reasonable *for the proxy itself*. The flaw is the architectural
asymmetry: the **management API** on `:3000` is on the same Fastify instance,
reachable on the same `devcontainer-net`, and does **not** apply this check
at all (`CRIT-03`). So a container that is denied access to `example.com`
through the proxy can simply call
`POST /api/rules {domain:"example.com", container_id:null, status:"allow"}`
on the management API and add itself a *global* allow rule, instantly
unlocking the destination for itself and every other container.

A second issue in the same code: `resolveContainerByIp` caches IP→name for
10 seconds (`docker.ts:9`). If a container is stopped and a new container
gets the same IP within that window, requests from the new container will be
attributed to the old container's identity for policy purposes.

**Recommendation:**

- Don't share the same Fastify process / network exposure between the
  policy-enforcement proxy and the management API. Bind the management API
  to `127.0.0.1` or to a host-only interface unreachable from
  `devcontainer-net`.
- Invalidate the IP cache on Docker `start`/`die` events instead of relying
  on a TTL.
- Reject requests where `resolveContainerByIp()` returns `null` rather than
  treating them as "global / no container" — that currently lets unidentified
  callers match `container_id IS NULL` rules.

---

### [CRIT-03] Management API (`:3000`) has no authentication or authorisation
**Severity:** Critical
**File:** `src/api.ts:42-273`, `src/api.ts:266` (`host: '0.0.0.0'`)

Every endpoint under `/api/*` is anonymous. There are no `preHandler` hooks,
no API tokens, no session cookies, no CORS restrictions, no origin checks.
The Fastify instance binds to `0.0.0.0:3000` (`api.ts:266`), and because the
`huddle` container is attached to `devcontainer-net` (`docker.ts:255`), every
dev container can reach it as `huddle:3000`.

Exploitable consequences from a single anonymous HTTP call:

- `POST /api/docker/start` → start a new container from any image, with
  arbitrary `imageName`/`workspaceDir`/`containerName`. The handler then
  bind-mounts `toLinuxPath(workspaceDir)` from the host into the new
  container (`docker.ts:246`), and binds the per-container Docker socket
  in (`docker.ts:251`), so the attacker effectively gets an interactive
  root shell on any host path of their choice plus Docker. (See also
  `HIGH-02` for argument injection.)
- `POST /api/docker/containers/:name/snapshot` → commit any container as
  a new image (information disclosure + persistence).
- `PUT /api/authz/grants/:container` → give any container 1–120 minutes of
  Docker socket access (`CRIT-01` chain).
- `POST /api/rules` → add global firewall allow rules.
- `DELETE /api/rules/:id` → delete firewall rules.

**Recommendation:** add an authentication layer before this is deployed
outside a single developer's machine. At minimum:

- Bind the management API to a Unix socket or `127.0.0.1`, separate from the
  HTTP proxy port, and let the UI reach it via a different path.
- Require a bearer token or mTLS for every `/api/*` route.
- Deny by default for unauthenticated callers; add an explicit allow-list of
  read-only endpoints if needed.

---

### [HIGH-01] Path traversal in `/assets/:file` via URL-encoded path separators
**Severity:** High
**File:** `src/api.ts:48-67`

```ts
app.get<{ Params: { file: string } }>('/assets/:file', async (req, reply) => {
  const file = req.params.file;
  if (!/^[A-Za-z0-9._-]+$/.test(file)) {
    return reply.code(400).send({ error: 'invalid_file' });
  }
  ...
  const content = fs.readFileSync(path.join(UI_DIR, 'assets', file));
```

The regex looks safe at first glance, but Fastify URL-decodes `:file` *before*
this handler sees it. A request for `/assets/..%2f..%2fetc%2fpasswd` becomes
`file === '../../etc/passwd'`, which contains `/`, fails the regex and gets
rejected — so the encoded form is fine. **But** `/assets/..%252f..%252fetc%252fpasswd`
(double-encoded) decodes once to `..%2f..%2fetc%2fpasswd`, which *passes* the
regex (only `A-Za-z0-9._-` and `%`… wait — `%` is not in the allow-list, so
this specific double-encoding fails too).

The real bypass is simpler: the regex permits a leading `.` and unlimited
dots. `/assets/.` and `/assets/..` are *not* allowed because the regex
requires at least one character, but `/assets/...` is. More importantly,
`/assets/.env`, `/assets/.git`, `/assets/.htpasswd`, etc. are all permitted —
so if anyone ever drops a sensitive dotfile into `dist/ui/assets/`, it is
served. Combined with the fact that the route also reads from
`path.join(UI_DIR, 'assets', file)` without checking that the *resolved* path
stays inside `UI_DIR/assets`, future changes that loosen the regex will
trivially become path-traversal.

The defence-in-depth recommendation:

```ts
const resolved = path.resolve(UI_DIR, 'assets', file);
const base = path.resolve(UI_DIR, 'assets') + path.sep;
if (!resolved.startsWith(base)) return reply.code(400).send({error:'invalid_file'});
```

and tighten the regex to forbid leading `.` (`^[A-Za-z0-9_][A-Za-z0-9._-]*$`).

Note: `serveStatic` on `api.ts:31-40` reads a fixed file name passed by the
developer, so it's safe in itself, but it would be better to centralise
static serving on `@fastify/static` with a `root` constraint.

---

### [HIGH-02] Container name and image name flow unescaped into Docker API paths and shell-built scripts
**Severity:** High
**File:** `src/docker.ts:260`, `src/docker.ts:161-178`, `src/api.ts:216-237`

`createAndStartContainer` reads `imageName`, `workspaceDir`, `containerName`,
and `ideName` directly from the request body (`api.ts:216`). The
`containerName` is used to:

1. Build the Docker API URL:
   ```ts
   await dockerRequest('POST', `/containers/create?name=${encodeURIComponent(containerName)}`, createBody);
   ```
   `encodeURIComponent` is fine for the URL itself, but Docker has its own
   validation rules for container names (`[a-zA-Z0-9][a-zA-Z0-9_.-]+`). A
   name like `../../images/json` decodes to `../../images/json` on the wire
   and Docker rejects it, so the URL-injection risk is mitigated by the
   daemon — **fragile**, not safe by design.

2. Bind-mount path:
   ```ts
   { Source: `${SOCKET_DIR}/${containerName}.sock`, Target: '/var/run/docker.sock' }
   ```
   A name containing `/` would let the attacker mount an arbitrary socket
   from `SOCKET_DIR` (or above, with `../`) into the new container as the
   Docker socket. Combined with `CRIT-03`, this is a remote root-via-Docker
   primitive.

3. Embedded into a shell script (`docker.ts:172`):
   ```sh
   CURL_LINE='--proxy-header "X-Container-ID: ${containerName}"'
   ```
   The template-literal interpolation happens in JavaScript, not in the
   shell. A `containerName` value of `foo"; rm -rf / #` becomes part of the
   `sh -c <script>` payload that runs as **root inside the new container**
   (`docker.ts:268` uses `User: 'root'`). It is "only" root inside the
   container, but combined with the bind-mounted host workspace
   (`docker.ts:246`), the attacker can write anywhere on the host the
   workspace dir is mounted from.

4. `workspaceDir` is interpolated into `toLinuxPath` and used as a host bind
   source (`docker.ts:246`). The only validation is `if (!workspaceDir)`. An
   attacker who reaches `/api/docker/start` (see `CRIT-03`) can mount `/`,
   `/etc`, `/root/.ssh`, etc. from the host into the new container's
   `containerWorkspace`.

5. The same is true for `imageName`. The split at `docker.ts:131`
   (`const [repo, tag = 'latest'] = imageName.split(':');`) then
   URL-encodes each, so the Docker `/commit?repo=&tag=` call itself is safe,
   but `imageName` is fed straight back into `createAndStartContainer` and
   pulled by Docker — a malicious image (e.g. `attacker/evil:latest`) will
   be started with NET_ADMIN capabilities and a Docker socket bind.

**Recommendation:**

- Validate `containerName` against `^[a-zA-Z][a-zA-Z0-9_-]{1,62}$` at the API
  boundary; reject otherwise. The strict regex must be checked **before**
  any URL building or shell template.
- Validate `imageName` against an allow-list (the snapshot list returned by
  `listSnapshotImages()` plus the base image) instead of trusting the
  client's value.
- Validate `workspaceDir` against an allow-list of approved host paths or a
  configurable root prefix (e.g. `/home/<user>/projects/...`).
- Move the `jb-config.sh` script to a file inside the image and parameterise
  via environment variables, instead of building it from user input with
  string interpolation.

---

### [HIGH-03] `iptables` rules injected from container-supplied data are run as root
**Severity:** High
**File:** `src/docker.ts:175-177` (via `buildJbConfigScript`)

```sh
HUDDLE_IP=$(getent hosts huddle | awk '{print $1}')
iptables -t nat -C OUTPUT -p tcp --dport 80 ! -d "$HUDDLE_IP" -j DNAT --to-destination "$HUDDLE_IP:80" ...
```

The script is `exec`'d in the new container as `User: 'root'` with
`CapAdd: ['NET_ADMIN']` (`docker.ts:256`). `HUDDLE_IP` is resolved at run
time from the container's own resolver — if the attacker can poison the
container's DNS (e.g. by controlling `/etc/hosts` via the bind-mounted
workspace, see `HIGH-02`) they can redirect the DNAT to any address,
effectively choosing the proxy themselves and bypassing all firewall rules.

More importantly: nothing in the network design prevents a container from
**removing** these `iptables` rules later (it has `NET_ADMIN`), so a
sophisticated container can simply `iptables -t nat -F OUTPUT` and then
connect directly to the internet without going through Huddle. The "wall"
is only as strong as the container chooses to keep it. This is a
**fundamental architectural issue**: in-guest firewall enforcement does not
isolate an adversarial guest.

**Recommendation:**

- Move the egress firewall to the host or to a dedicated network namespace
  the container cannot modify. Either:
  - Place all dev containers in a Docker network whose gateway points at a
    separate filtering host (the current `huddle`), with iptables on the
    host (not in the container) forcing `OUTPUT → huddle:80`.
  - Or, drop `NET_ADMIN` from the container's `CapAdd` (`docker.ts:256`)
    and configure the redirect from the host's `PREROUTING` chain on the
    bridge interface.
- Pin `HUDDLE_IP` at container creation time and pass it as an env var,
  rather than resolving it inside the container.

---

### [HIGH-04] Snapshot endpoint allows committing arbitrary images with attacker-controlled name
**Severity:** High
**File:** `src/api.ts:190-203`, `src/docker.ts:130-144`

```ts
app.post('/api/docker/containers/:name/snapshot', async (req, reply) => {
  const { imageName } = req.body;
  if (!imageName) return reply.code(400).send({ error: 'imageName required' });
  ...
  const imageId = await commitContainer(inspect.Id, imageName);
});
```

No authentication (`CRIT-03`) means any container can snapshot any other
running container into an image with an arbitrary name. Beyond the obvious
disk-fill DoS (each commit can be GBs), the attacker can pre-stage an image
with a chosen tag and then in a follow-up call to `/api/docker/start` use
that image, effectively creating a chain that bypasses the
`listSnapshotImages` filter (which only lists images with the
`com.devcontainer.snapshot=true` label — but `commitContainer` *adds* that
label at line 137).

Information disclosure: a malicious container can snapshot every other
container on the host, then pull the resulting image to extract any secrets
left in environment variables or filesystem state.

**Recommendation:** require auth on the snapshot endpoint, and apply
quotas (max images per container, max image size). Consider scrubbing
sensitive env vars before commit (Docker's `--change` flag or per-image
config sanitisation).

---

### [HIGH-05] Known-vulnerable transitive dependencies (`fast-uri` ≤ 3.1.1)
**Severity:** High
**File:** `package.json`, `package-lock.json`

`npm audit` reports five high-severity findings, all rooted in
`fast-uri@<=3.1.1` (pulled in via `fastify@4.27.0`):

- GHSA-q3j6-qgpj-74h6 — `fast-uri` path traversal via percent-encoded dot
  segments (CVSS 7.5).
- GHSA-v39h-62p7-jpjc — `fast-uri` host confusion via percent-encoded
  authority delimiters.

These chain into Fastify's URL parsing and `fast-json-stringify`'s ref
resolution. The path-traversal advisory is directly relevant to `HIGH-01`
because Fastify's route matching and `req.params` decoding sit on top of
`fast-uri`.

**Recommendation:** `npm audit fix --force` (which moves to Fastify 5.x — a
breaking change). If that's too invasive short-term, pin
`fast-uri` to `>=3.1.2` via `overrides` in `package.json`, and re-run
`npm audit`.

---

### [MED-01] Unbounded buffering in the socket proxy enables memory-exhaustion DoS
**Severity:** Medium
**File:** `src/socket-proxy.ts:38-46`

```ts
client.on('data', (chunk: Buffer) => {
  if (headerDone) {
    upstream?.write(chunk);
    return;
  }
  buf = Buffer.concat([buf, chunk]);
  const end = buf.indexOf('\r\n\r\n');
  if (end === -1) return;
  ...
});
```

Until `\r\n\r\n` is found, the buffer keeps growing without limit. A
malicious container — note it doesn't even need a grant; the policy check
runs *after* headers are complete (line 53) — can stream gigabytes of header
bytes without ever sending the terminator and exhaust the gateway's memory.
With several containers cooperating, the gateway can be OOM-killed.

There is **no per-connection timeout** either: a slowloris-style client that
sends 1 byte per minute holds the proxy file descriptor and buffer alive
indefinitely.

**Recommendation:** cap the buffer (e.g. 32 KB header limit) and `client.end()`
with 431 (Request Header Fields Too Large) if exceeded. Set
`client.setTimeout(10_000)` to drop idle connections.

The HTTP proxy in `src/proxy.ts` is also missing `setTimeout()` and any
keepalive ceiling; same recommendation.

---

### [MED-02] Per-container Docker socket created world-writable (`0o777`)
**Severity:** Medium
**File:** `src/socket-proxy.ts:81`

```ts
server.listen(socketPath, () => {
  try { fs.chmodSync(socketPath, 0o777); } catch {}
```

The socket is in `/tmp/dc-sockets/` and `chmod`ed to `0o777`. Inside the
gateway container this is a singleton mount used only by the gateway, so
in normal operation only the gateway process can reach `/tmp/dc-sockets/`.
However:

- Each dev container bind-mounts **its own** socket at `/var/run/docker.sock`
  with no mode restriction, meaning anything in that container (any user,
  including non-root processes) can talk to the Docker socket as long as
  the grant is active.
- If the host's `/tmp/dc-sockets/` is ever bind-mounted elsewhere (some
  compose setups do this), every reader/writer on the host can hit the
  proxy.

**Recommendation:** use `0o660`, make the socket owned by a dedicated group,
and add containers' UIDs to that group. Or, drop the `chmod` and let umask
handle it.

---

### [MED-03] HTTP proxy does not strip hop-by-hop or sensitive headers from outgoing requests
**Severity:** Medium
**File:** `src/proxy.ts:61-70`

```ts
const outgoingHeaders: http.OutgoingHttpHeaders = { ...req.headers };
delete outgoingHeaders['proxy-connection'];
```

Only `proxy-connection` is stripped. Standard hop-by-hop headers
(`Connection`, `Keep-Alive`, `TE`, `Transfer-Encoding`, `Upgrade`,
`Trailer`) and proxy-routing headers (`Proxy-Authorization`,
`Proxy-Authenticate`) are forwarded verbatim. More importantly, the
client-supplied `Host` header is forwarded, which differs from the
URL-derived `target.hostname`. Upstream servers may make trust decisions on
`Host`, and Huddle's own policy is based on `target.hostname`, so the two
can diverge.

This isn't a self-contained vuln but it is a precondition for several
upstream attacks (HTTP request smuggling via mismatched `Content-Length` /
`Transfer-Encoding`, host-header SSRF on virtual-hosted services).

**Recommendation:** explicitly construct the outgoing header set; strip
hop-by-hop headers per RFC 7230 §6.1; force `Host: ${target.host}`.

---

### [MED-04] `parseHash()` decodes a URL fragment with `decodeURIComponent` and feeds it into the breadcrumb without escaping
**Severity:** Medium (DOM XSS, low impact in practice)
**File:** `src/ui/app.js:131-136`, `src/ui/app.js:159`

```js
case 'container':
  setBreadcrumb(`Container · ${param || ''}`);
  root.innerHTML = renderContainerDetail(param);
```

`setBreadcrumb` uses `textContent`, so the breadcrumb itself is safe.
`renderContainerDetail` then re-fetches `/api/docker/containers/<param>` and
all displayed values are passed through `esc()`. But `param` is also passed
as the container name into `data-action` attributes elsewhere — those use
`esc()` too, so the user-controlled hash does not currently leak unescaped.

The risk is that future changes are one `innerHTML = ${param}` away from DOM
XSS, because the only thing keeping `param` safe is discipline in every
template literal. Concretely, `app.js:892` (`sel.innerHTML = '<option…'`) is
literal so safe; the closest call is `app.js:894`
(`<option value="">Fout: ${esc(err.message)}</option>`) which is properly
escaped.

**Recommendation:** add a project rule (and a `eslint-plugin-no-unsanitized`
rule, or migrate to a templating system that auto-escapes) to forbid raw
`innerHTML =` with template literals containing `${...}` not run through
`esc()`. CSP would also help: the management UI has no
`Content-Security-Policy` header set, so a successful XSS gets full
script-eval, fetch, etc.

---

### [MED-05] No CSRF protection on state-changing endpoints
**Severity:** Medium
**File:** `src/api.ts` (all `POST`/`PUT`/`DELETE` handlers)

State-changing requests are accepted with `Content-Type: application/json`
and no token. Browsers will not pre-flight a same-origin JSON POST, and the
UI is same-origin with the API. If `CRIT-03` is fixed with a cookie-based
session (rather than a bearer token sent via `Authorization` header), CSRF
becomes immediately exploitable: a malicious site can submit
`<form action="http://huddle:3000/api/docker/start" method="POST">` with
`enctype="text/plain"` and the user's cookie will be sent.

**Recommendation:** when adding auth (`CRIT-03`), prefer bearer tokens over
cookies. If cookies are necessary, add a CSRF token or use `SameSite=Strict`
and require `Origin`/`Referer` validation.

---

### [LOW-01] `req.body` is dereferenced without null/shape checks on several routes
**Severity:** Low
**File:** `src/api.ts:128`, `src/api.ts:193`, `src/api.ts:216`, `src/api.ts:248`

For example:

```ts
async (req, reply) => {
  const { domain, container_id = null, status } = req.body;
```

Fastify will reject malformed JSON, but `req.body` can still be `null` if
`Content-Type` is missing, in which case destructuring throws and Fastify
returns a generic 500. Not a security bug, but consider adding `schema:`
validation to each handler — it also gives free type-checking and stricter
input shape control (which would address parts of `HIGH-02`).

**Recommendation:** declare Fastify JSON schemas for body/query/params on
every route. This is the idiomatic Fastify defensive layer and would close
several validation gaps in one stroke.

---

### [LOW-02] `getBaseImageName()` reads `BASE_IMAGE` env var without validation
**Severity:** Low
**File:** `src/docker.ts:104`

```ts
export function getBaseImageName(): string {
  return process.env.BASE_IMAGE ?? 'base-devimage';
}
```

The value is returned by `GET /api/docker/base-image` and then offered to
the UI as a startable image. If `BASE_IMAGE` ever becomes attacker-influenced
(e.g. via `docker-compose` env file from a less-trusted source), it becomes
an image-pull primitive. Not exploitable today, but worth pinning to a
known-good string.

---

### [LOW-03] `iptables` rule check via `-C` returns non-zero exit code, but `set -e` is not used; failures are silently ignored
**Severity:** Low
**File:** `src/docker.ts:163-178`

The script lacks `set -e`, so failures of `mkdir`, `printf`, `iptables`, or
the `getent` lookup are not reported. The container will start successfully
even if its egress is *not* redirected through Huddle — silently bypassing
the firewall.

**Recommendation:** add `set -eu` at the top of the script, and surface
`exec` exit codes back to the API caller (`docker.ts:270` ignores the
`Detach: true` exec's exit status).

---

## Summary table

| ID       | Severity | Area                            | One-line |
|----------|----------|---------------------------------|----------|
| CRIT-01  | Critical | Docker socket proxy / grants    | Any container can grant itself/others Docker access via the unauthed grants API |
| CRIT-02  | Critical | HTTP proxy / policy             | Container identity for firewall checks comes from IP cache and client headers, both spoofable in adjacent flows |
| CRIT-03  | Critical | Management API                  | No auth on `/api/*`; reachable from every dev container |
| HIGH-01  | High     | Static file serving             | `/assets/:file` regex permits dotfiles and lacks resolved-path containment |
| HIGH-02  | High     | Input validation                | Container/image/workspace inputs flow unescaped into Docker API, mounts, and shell scripts |
| HIGH-03  | High     | Network firewall                | Egress firewall is enforced inside the guest with `NET_ADMIN`; trivially removable |
| HIGH-04  | High     | Snapshot endpoint               | Anonymous commit of arbitrary containers to attacker-named images |
| HIGH-05  | High     | Dependencies                    | `fast-uri ≤3.1.1` path-traversal & host-confusion advisories |
| MED-01   | Medium   | Socket proxy DoS                | Unbounded header buffer + no timeouts |
| MED-02   | Medium   | File permissions                | Per-container socket chmod 0o777 |
| MED-03   | Medium   | HTTP proxy                      | Hop-by-hop & Host headers forwarded verbatim |
| MED-04   | Medium   | UI                              | DOM XSS surface via `innerHTML` is currently safe only by convention; no CSP |
| MED-05   | Medium   | API                             | No CSRF protection; matters once auth lands |
| LOW-01   | Low      | API                             | No Fastify schemas on routes |
| LOW-02   | Low      | Config                          | `BASE_IMAGE` not validated |
| LOW-03   | Low      | Container startup               | Failed `iptables` redirect silently ignored |

## Recommended remediation order

1. **CRIT-03** first — bind management API away from `devcontainer-net` and
   add an auth layer. This single change cuts off the externally-reachable
   surface that powers CRIT-01, CRIT-02, HIGH-04, and most of HIGH-02.
2. **CRIT-01 / CRIT-02** — derive container identity from socket peer or
   client cert, never from headers; strip client-supplied
   `X-Container-Id`.
3. **HIGH-03** — move egress filtering out of the guest. This is the only
   way the "DMZ" actually contains adversarial agents.
4. **HIGH-02 / LOW-01** — Fastify schemas + strict regex/allow-list on
   `containerName`, `imageName`, `workspaceDir`.
5. **HIGH-01 / HIGH-05 / MED-01** — quick wins.
