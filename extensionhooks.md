# Huddle Extension Platform — Architecture Change Note (Draft)

**Change:** add a defined hook contract and a transforming egress interceptor to the extension platform.
**Motivation:** today extensions can only *react* to events. This lets them participate in lifecycle, firewall, Docker, and egress decisions — and rewrite outbound calls in-flight.
**Compatibility:** additive. Existing extensions keep working; new capabilities are opt-in.

---

## Hooks

Two kinds: **decision hooks** (`onFirewallRequest`, `onDockerAction`, `onEgress`) return a verdict and fail-closed; **observer hooks** (all others) are fire-and-forget notifications whose return value is ignored.

**Extension lifecycle:**
- `onInstall` / `onUninstall` : extension zip uploaded / removed — seed vs. full teardown
- `onEnable` / `onDisable` : extension toggled on / off — (de)register hooks & rules

**Container lifecycle** (payload `c`: `{ name, image, ide, labels, startedAt }`):
- `onContainerPreStart(c)` : before a devcontainer is up
- `onContainerPostStart(c)` : every start
- `onContainerAttach(c)` : IDE attaches
- `onContainerPreStop(c)` / `onContainerPostStop(c)` : before / after stop

**Firewall** (`req`: `{ container, domain, method?, path? }`, `rule`: `{ id, container|null, domain, action, expiresAt?, methods? }`):
- `onFirewallRequest(req)` → `allow` (override) / `deny` (override) / `continue` (defer to operator) : container requests a blocked domain
- `onFirewallRuleAdded(rule)` : rule created — observe/audit
- `onFirewallRuleRemoved(rule)` : rule deleted
- `onFirewallRuleExpired(rule)` : time-bound rule expires — e.g. re-arm, notify

**Docker** (`action`: `{ container, verb, resource, labels }`, e.g. `verb: "image.push"`):
- `onDockerGrant(container, minutes)` : grant issued
- `onDockerRevoke(container)` : grant revoked / expired
- `onDockerAction(action)` → `allow` (override) / `deny` (override) / `continue` (defer to policy) : container attempts a Docker action
- `onPortPublish(binding)` → `allow` (override) / `deny` (override) / `continue` (defer to approved-ports list) : container attempts to bind a host port — `binding`: `{ container, hostPort, containerPort, protocol }`

**Egress** (`req`: `{ container, protocol, method, host, port, path, headers }`):
- `onEgress({ match, handler })` : intercept an outbound call — `match` pre-filters cheaply, `handler` returns the call that actually happens
    - handler returns `req` unchanged : proceeds as-is
    - handler returns modified `req` : rewritten / redirected call goes out
    - handler returns `api.block(reason)` : dropped, logged
    - handler returns `api.request(reason)` : pending firewall request (operator decides)

---

## Actions

State-changing helpers — thin wrappers over existing endpoints, so extensions never touch iptables/SQLite directly.

**Firewall:**
- `ctx.firewall.addRule / removeRule / updateRule` : manage rules — backed by `/api/rules...`
- `ctx.firewall.grantTemporary(match, minutes)` : open a time-bound rule

**Docker:**
- `ctx.docker.grant(c, minutes)` / `revoke(c)` : manage grants — backed by `/api/authz/grants/:container`
- `ctx.docker.addPort(c, { hostPort, containerPort, protocol, description? })` / `removePort(c, hostPort)` : manage the container's approved host-port bindings (default: none — container cannot bind host ports)

**Containers (new):**
- `ctx.containers.create({ image, env, mounts, labels })` : provision a devcontainer — fires `onContainerCreate` / `onContainerPostStart`
- `ctx.containers.start(name)` / `stop(name)` : start / stop an existing container

**Audit:**
- `ctx.audit.log(entry)` : write to the network/admin log

---

## Notes

- **Package (unchanged):** `.zip` with `manifest.json` + `index.js` (`register(ctx)`) + optional `frontend/component.js`. Existing `ctx`: routes, `getSetting/setSetting`, `ctx.fetch`, `runInContainer`, `ctx.events`, `ctx.db`, `ctx.log`.
- **Egress performance:** `match` is pure/sync, string checks only — no I/O, no await. Non-matching traffic never enters extension code.
- **HTTPS:** TLS is offloaded/onloaded at the proxy, so the handler sees the decrypted request (method, path, headers, body). Exception: raw TCP tunnels (e.g. SSH port 22) expose host + port only.
- **Teardown contract:** whatever `onInstall`/`onEnable` adds, the matching teardown removes.
- **Rule `methods` (new, optional):** rules gain an optional `methods` allow-list so filtering can be method-aware (e.g. allow `GET`/`HEAD`, block `POST`), enforced via the egress handler.

---

## Extension ideas

Candidate extensions to build against this contract (also good workshop anchors):

- **Git push allow once** — default-deny pushes to the Git host; UI button opens a one-shot grant; `onEgress` inspects the decrypted request (`git-receive-pack`), lets one push through, then re-closes. HTTPS only; SSH falls back to a time-boxed window.
- **Auto-clear stale requests** — track each pending `onFirewallRequest` with a timestamp; a timer sweeps and clears (removes, not denies) any still-unanswered > 30 min.
- **Per-method rule filter** — allow some REST methods and block others per host, using the new rule `methods` field enforced in `onEgress`.
- **Freshdesk ticket → devcontainer** — poll (or webhook) Freshdesk for new tickets; on create, `ctx.containers.create(...)` with the ticket baked in as env/mounted `ticket.json`. (Open: file-copy vs. Git-based project setup per ticket.)

---

## Decisions

1. **Interceptor ordering: chained.** Multiple matching egress interceptors run in sequence; each receives the (possibly modified) `req` from the previous. Define the chain order explicitly.
2. **Hook failure: fail-closed.** If a decision hook (`onFirewallRequest`, `onDockerAction`, `onEgress`) throws, the call is blocked, not allowed — a security gateway defaults to denying.
3. **Freeze event names/payloads as a versioned contract** before wide adoption, so later extensions don't break on renames.
4. **Observer hooks are fire-and-forget.** Non-decision hooks (`onFirewallRuleAdded/Removed/Expired`, `onDockerGrant/Revoke`, container lifecycle) just notify — their return value is ignored and they can't block or delay the action.

---

## Rollout

Resolve open questions → land lifecycle + `ctx.hooks` (additive) → add firewall/Docker hooks → prototype egress against `proxy.ts` → dogfood internally → document + open to the team.

> Event names are proposed. Reconcile against `events.ts` before freezing.