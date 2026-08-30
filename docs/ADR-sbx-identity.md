# Identifying a Docker Sandbox at the Huddle gateway

Status: **proposed** — gated on the experiment in section 6, which has not been
run yet. Nothing here is implemented.
Branch: `feat/sbx-sandboxes-rebased`.

Goal: set the sbx network policy to allow-all outbound and make the Huddle
gateway the only thing deciding what a sandbox may reach — with the same policy
engine, the same path-level rules and the same audit as devcontainer mode.

---

## 1. Why this is not just "turn on allow-all"

A devcontainer is identified by its source address: the proxy resolves
`req.socket.remoteAddress` against the IP→container feed
(`control/client.ts:357`, fed by `ContainerFeed.byIp`) and evaluates
`checkRule(host, containerId, path)`.

Sandboxes have none of that. They share one listener (`SBX_PROXY_PORT`, 32768)
and are evaluated against the merge of global + *every* sandbox's rules:

```ts
// proxy.ts:416
const evalRule = (host, containerId, path) =>
  isSbxProxy ? checkFleetRule(host, knownSandboxNames(), path) : checkRule(host, containerId, path);
```

That merge is safe today for one reason, written down at `proxy.ts:407`: **sbx
has already enforced per-box policy before forwarding**, so allow-if-any-sandbox-
allows can only ever be narrower than what already passed. Setting sbx to
allow-all removes exactly that premise. The merge then stops being a
conservative approximation and becomes a hole: sandbox A may reach everything
sandbox B is allowed to reach.

So allow-all and identity are not two independent steps. **Identity has to work
first**; allow-all is the last step, not the first.

A second consequence is already visible today: `containerId` for sbx traffic
still comes from `resolveContainerByIp()`, which for a host-side caller resolves
to `null`. Sandbox requests are therefore audited as unattributed, and a blocked
domain is filed as a *global* `requested` rule rather than against the box that
asked for it.

## 2. What can carry the identity — and what cannot

The decisive fact is that **the gateway never talks to a sandbox**. It talks to
the sbx host-side daemon, which terminates and rewrites. From Docker's
credentials documentation:

> the host-side proxy terminates and rewrites headers before forwarding requests

> credentials do not reach upstream proxies

That rules out both obvious approaches:

| Candidate | Verdict |
|---|---|
| Source address | **Dead.** Every box reaches us as the same host-side daemon. |
| A header, env var or client cert set inside the box | **Dead.** That is precisely what is stripped. |
| `sbx secret` | **Wrong tool.** It injects credentials *toward* declared API domains — sbx's counterpart to Huddle's token exchange, which `proxy.ts:420` already defers to. It never reaches an upstream proxy. |
| Credentials in the upstream-proxy URL | **Survives.** |

The last one survives for a structural reason, not by luck: it is not payload
from the box, it is the *hop's own* authentication — what the daemon presents to
the upstream proxy in order to get through it at all. Something that must
survive for the connection to work cannot be stripped. Docker's upstream-proxy
documentation supports the form explicitly:

> `http://user:pass@host:port` for an HTTP or HTTPS proxy

## 3. Decision

Give every sandbox its own credential in the upstream-proxy URL, minted by
Huddle Node at create time. The gateway reads `Proxy-Authorization`, maps it to a
sandbox name, and evaluates `checkRule(host, 'sbx:<name>', path)` — the same call
devcontainers already take.

The setting key is global (`sbx settings set proxy.sandbox <url>`), which looks
like it defeats the whole idea. It does not, because of *when* it is read:

> Sandbox settings take effect on the next sandbox you create or restart;
> already-running sandboxes keep the proxy they were created with

The URL is **baked in at create**. A global key set immediately before each
create is therefore a per-sandbox injection — and Huddle already performs exactly
that sequence — `startSandbox` sets the global key and then creates, in that
order, as its own numbered step 1 and step 2:

```ts
// sbx.ts:122
await ops.setProxy({ which: 'sandbox', url: upstreamUrl });
...
// sbx.ts:137
const code = await ops.create({ name: opts.name, agent: agentName, ... });
```

Only the URL needs a per-box secret. The mechanism is in place.

**Unknown credential is denied.** Falling back to the fleet merge would make
identity advisory: anything that omits the credential would receive the widest
rights in the system, which is the opposite of what this ADR is for.

## 4. The restart hazard, and the mitigation

"…or restart" is the sharp edge. A restarting sandbox re-reads the *current*
global setting, which by then holds the most recently created box's credential.
Box A restarts and presents box B's identity. The gateway believes it, and A
inherits B's rules.

This does not fail — it silently succeeds as the wrong box. That is worse than a
denial, and it is not a corner case: **Huddle does not restart sandboxes.**
`sandbox/ops.ts` exposes `create` and `remove` and no start/stop/restart, so
every restart is out-of-band by construction.

Two measures, both required:

1. **Reset to an unclaimed credential after every create.** Huddle sets
   `proxy.sandbox` back to a URL whose credential maps to no sandbox. An
   out-of-band restart then presents an identity the gateway does not know, and
   is denied with a message naming the cause — instead of impersonating the last
   box created. This makes the failure mode safe without Huddle needing to own
   the restart path.
2. **Serialise sandbox creation.** A global key plus set-then-create is a race;
   `sbx.ts` has no lock today. Two concurrent creates can hand both boxes the
   same identity, or swap them.

A later step may add a Huddle-driven restart that sets the right credential
first. That is an improvement, not a substitute: measure 1 has to hold for
restarts Huddle never sees.

## 5. What changes where

| # | Where | Change |
|---|---|---|
| 1 | `sandbox/registry.ts` + db | A secret per sandbox, minted at create, stored with the name. |
| 2 | `sbx.ts:122-137`, `sandbox/ops.ts:284` | Per-box credential in the URL handed to `setProxy`; reset to the unclaimed credential afterwards; serialise creates. |
| 3 | `control/feed.ts`, `control/feed-build.ts` | Credential→name map in the container feed, as a **hash**. The gateway is deliberately the less-trusted half — `boot-gateway.ts` enforces that through the import graph — so it should be able to verify an identity without holding the secrets. |
| 4 | `proxy.ts:410-420` | Read `Proxy-Authorization` on `request`, `upgrade` and `connect`; resolve to `sbx:<name>`; **strip the header before forwarding**; call `checkRule` instead of `checkFleetRule`. `checkFleetRule`, `knownSandboxNames` and `ContainerFeed.sandboxes` can then go. |
| 5 | rules + portal | Sandboxes as a rule scope alongside containers, so a blocked domain is filed against the box that asked and path rules work per sandbox. |
| 6 | sbx policy | **Last.** Set the network policy to allow-all, once 1–5 demonstrably work. |

## 6. What has to be measured first

Two questions decide whether any of this is buildable, and both are about sbx's
behaviour rather than ours. `sbx-identity-test.mjs` answers them in one run: it
stands up a listener that enforces nothing and only records the credential it
was shown, creates two sandboxes with different credentials, curls from each,
then restarts the first and curls again.

1. **Does the credential arrive, per box, on CONNECT?** Two boxes presenting
   their own distinct credentials means the URL really is baked in at create and
   section 3 holds. Both presenting the *same* credential means the daemon reads
   the global setting live, and this channel is not an identity either — at which
   point there is no known mechanism left and the task needs a different plan.
2. **What does a restarted box present?** If it keeps its own credential, the
   mitigation in section 4 is unnecessary. If it adopts the current global value,
   measure 1 is mandatory before anything ships.

The script saves and restores the operator's existing `proxy.sandbox` on the way
out, including on failure: it is one setting for the whole machine.

## 7. Scope of the guarantee

This identifies *boxes*; it does not defend against a box that can read another
box's secret and impersonate it. Sandboxes are isolated from each other, so the
assumption holds — but it is an assumption, and it belongs here rather than in
someone's head. If sandboxes ever share a filesystem or a credential store, this
scheme degrades to "whoever asks first" and needs revisiting.
