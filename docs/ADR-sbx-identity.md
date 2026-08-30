# Identifying a Docker Sandbox at the Huddle gateway

Status: **accepted** — the experiment in section 8 ran on 2026-08-30 and confirms
the mechanism. Nothing is implemented yet.
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
allows can only ever be narrower than what already passed. That is now measured
rather than assumed: a curl from a sandbox to a host outside its allowlist comes
back 403 without the request ever reaching the upstream proxy. Setting sbx to
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

## 4. The restart question, and what we keep anyway

"…or restart" in that sentence is what made this look dangerous. A restarting
sandbox re-reading the *current* global value would come back holding the most
recently created box's credential — box A restarts, presents box B's identity,
and the gateway believes it. That does not fail; it silently succeeds as the
wrong box, which is worse than a denial.

**It does not happen.** Measured 2026-08-30: box A was stopped while the global
setting held box B's credential, brought back, and still presented `secret-a` —
on the request we sent and on its own background traffic afterwards. The
credential is fixed at create and a restart does not revisit it.

Two reasons not to close the question on that alone. The documentation says the
opposite of what we measured, so one of the two is describing a case the other
does not cover. And sbx has `stop` and no `start` and no `restart` (`sbx --help`,
2026-08-30) — a stopped sandbox returns when someone next uses it, so the only
restart we *can* drive is that one. A sandboxd restart or a reboot re-enters
through a path we have not exercised. `sbx-identity-test.mjs --daemon` covers the
daemon case; a reboot stays untested.

So the mitigation stays, demoted from required to cheap:

1. **Reset to an unclaimed credential after every create.** One extra
   `sbx settings set` per sandbox. If some restart path we have not hit does
   re-read the global value, it finds a credential mapping to no sandbox and is
   denied with a readable message, instead of impersonating the last box created.
   The price is one command; the thing it prevents is silent privilege transfer.
2. **Serialise sandbox creation.** This one is not about restarts and is not
   optional: a global key plus set-then-create is a race, and `sbx.ts` has no
   lock today. Two concurrent creates can hand both boxes the same identity, or
   swap them.

## 5. The secret itself

The username carries the sandbox name and the password carries the proof. The
name is a routing hint — it says which row to look up, and nothing more. Every
security property lives in the password.

So it has to be **unguessable**: 256 bits from a CSPRNG (`crypto.randomBytes(32)`,
base64url), minted fresh per sandbox. Never derived from the sandbox name, the
project, a counter or a timestamp. The proxy port is reachable by every process
on the operator's machine, so a derivable secret is not a weaker identity — it is
no identity at all, since anyone who can guess it can present any box's rights.
The same reason rules out reuse across boxes: two sandboxes sharing a secret are
one identity wearing two names, and the audit trail silently merges them.

Where it may live:

- **Huddle Node holds the secret.** It has to — it writes the URL.
- **The gateway holds only the SHA-256.** It needs to recognise an identity, not
  possess it, and it is deliberately the less-trusted half. Compare in constant
  time.
- **Nothing logs it.** That includes one place we already have: `sbx.ts` pushes
  `` `sbx settings set proxy.sandbox ${upstreamUrl}` `` into `SbxStep.command`,
  and the portal shows those steps verbatim so an operator can see which command
  broke. The moment that URL carries a credential, this prints it to the screen
  and into every log that captures it. The step must show a redacted URL.
- **The sandbox never sees it.** sbx keeps the upstream-proxy credential on the
  host side; the box is not given it. That is sbx's guarantee rather than ours,
  and it is the guarantee this whole scheme leans on — see section 9.

A new sandbox means a new secret; `sbx rm` drops it. There is no rotation story
beyond that because a sandbox does not outlive its credential.

## 6. Allow-all in sbx, everything in Huddle

Today `sandbox/reconcile.ts` projects Huddle's ruleset into sbx's own policy
engine, one-way, and reconciles drift. That design exists *because* the gateway
could not tell boxes apart: if per-sandbox decisions cannot be made at the proxy,
they have to be made where the sandbox is known, which is sbx. It comes with an
honest limitation the code already documents — sbx policy is domain-level, so
path rules are not projected at all and are enforced fleet-wide or not at all.

Identity inverts that. Set every Huddle-managed sandbox to **allow-all outbound**
and let the gateway make every decision:

- Path rules become per-sandbox, which sbx cannot express and Huddle can. That is
  the actual prize — "this box may reach the npm registry only for these
  packages" is a rule you can finally write about a sandbox.
- One policy engine, one audit trail, one place an operator approves a domain.
  Today a sandbox's blocked domain and a devcontainer's blocked domain arrive
  through different machinery.
- No drift to reconcile: `reconcile.ts` shrinks from mirroring a ruleset to
  ensuring exactly one allow-all rule per Huddle sandbox. `projection.ts` and the
  `notProjected` reporting go with it.

**Scope it per sandbox** (`--sandbox <name>`), never globally. A machine can hold
sandboxes Huddle did not create, and widening their policy is not ours to do.

Two properties this makes load-bearing:

1. **Ordering is a safety property, not a preference.** Allow-all removes the
   premise `checkFleetRule` rests on (section 1). Per-box identity, allow-all and
   the deletion of the fleet merge have to land together. Allow-all first, for
   even one commit, means every sandbox may reach whatever any sandbox may reach.
2. **Fail closed, everywhere.** An unknown or absent credential is denied. With
   sbx allow-all there is nothing behind us: the gateway's "no" is the only thing
   between a sandbox and the internet. That includes the gateway being down or
   the control feed being stale — the same fail-closed posture devcontainers
   already have, now with no second layer to hide a mistake.

## 7. What changes where

| # | Where | Change |
|---|---|---|
| 1 | `sandbox/registry.ts` + db | A 256-bit CSPRNG secret per sandbox, minted at create, stored with the name. |
| 2 | `sbx.ts:122-137`, `sandbox/ops.ts:284` | Credentialed URL handed to `setProxy`; **redact it in `SbxStep.command`**; reset to the unclaimed credential after create; serialise creates. |
| 3 | `control/feed.ts`, `control/feed-build.ts` | SHA-256 → sandbox name in the container feed. The hash, not the secret. |
| 4 | `proxy.ts:410-420` | Read `Proxy-Authorization` on `request`, `upgrade` and `connect`; constant-time match to `sbx:<name>`; **strip the header before forwarding**; `checkRule` instead of `checkFleetRule`. `checkFleetRule`, `knownSandboxNames` and `ContainerFeed.sandboxes` then go. |
| 5 | rules + portal | Sandboxes as a rule scope alongside containers, so a blocked domain files against the box that asked and path rules work per sandbox. |
| 6 | `sandbox/reconcile.ts`, `sandbox/projection.ts` | From mirroring the ruleset to ensuring one allow-all rule per Huddle sandbox. |
| 7 | — | 4, 5 and 6 ship together (section 6, ordering). |

## 8. What was measured

`sbx-identity-test.mjs` stands up a listener that enforces nothing and only
records the credential it was shown, creates two sandboxes with different
credentials, curls from each to its own destination, then stops the first and
curls again to bring it back. Run on 2026-08-30:

```
curl huddle-probe-a        example.com   huddle-probe-a:secret-a
curl huddle-probe-b        example.org   huddle-probe-b:secret-b
curl huddle-probe-a na herstart  example.net   huddle-probe-a:secret-a
```

Both boxes present their own credential, and box A keeps it across a restart
while the global setting says otherwise. Section 3 holds.

Three things the experiment had to get right, each learned by getting it wrong
first, and each worth keeping in mind before trusting a future run:

- **Each box curls its own destination.** A sandbox calls out on its own —
  `api.anthropic.com`, continuously — and attributing hits to whatever phase was
  running counts that background traffic as the answer.
- **The destination is allowed in that box's sbx policy first.** Otherwise sbx
  returns 403 by itself and the request never arrives, which reads as "no
  identity" when nothing was measured at all.
- **`proxy.sandbox` is restored on the way out, and never restored to our own
  probe URL.** It is one setting for the whole machine; a sandbox created while
  it points at a dead port reaches nothing.

The background traffic is worth a note of its own, because it is the strongest
single piece of evidence: box A's calls carried `secret-a` while the global
setting had already moved to box B. A credential that outlives the setting that
produced it was baked in.

## 9. Scope of the guarantee

This identifies *boxes*. It does not defend against a box that has its own
secret and hands it to something else, and it does not defend against a box that
can read another box's secret.

The first is inherent: an identity is a bearer of a credential, and any bearer
token can be shared by whoever holds it. The second is sbx's to guarantee — the
upstream-proxy credential stays on the host and the sandbox is not given it. We
rely on that, and it is written here because it is the assumption the design
rests on, not because we have measured it. If a future sbx exposes the proxy URL
inside the box, this scheme degrades to "whoever asks first" and needs revisiting.
