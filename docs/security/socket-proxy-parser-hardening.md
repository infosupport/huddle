# Socket-proxy hardening — JSON parser-differential (host-escape class)

This change closes a class of host-escape bypasses against the per-container
Docker **socket-proxy** (`gateway/src/socket-proxy.ts`). All were confirmed with
an authorized PoC suite (`poc-suite.sh`, vectors `1a`/`1b`/`1c`/`fs`, `7`, `mask`)
run from inside a devcontainer of a self-owned Huddle instance.

## Root cause — a parser differential

The socket-proxy inspects the JSON body of `POST /containers/create`,
`/volumes/create` and (now) `/containers/<id>/exec`, then forwards it to the real
Docker daemon. The proxy is JavaScript and read keys **case-sensitively**
(`body.HostConfig.Privileged`, `mount.Type`, …). The daemon's Go `encoding/json`
decoder maps struct fields **case-insensitively** and **merges duplicate keys**.

Anything the proxy validated under one casing, the daemon would honour under
another. That gap defeated every HostConfig guard:

| PoC | Payload | Why it slipped through | Result |
|-----|---------|------------------------|--------|
| `1a` | top-level `"hostconfig": {…}` (lowercase) | proxy read `body.HostConfig` → `undefined`; then it *added* its own `HostConfig` (NetworkMode) → the forwarded body had **both** keys, which Go merges | privileged + `pidmode:host` + `/:/host` → host code-exec |
| `1b` | `"HostConfig": { "privileged": true, "pidmode": "host", "binds": [...] }` | proxy checked `HostConfig.Privileged` (capital) → `undefined` | same |
| `1c` | `"HostConfig": { "binds": ["/:/host"] }` | proxy checked `HostConfig.Binds` (capital) → skipped | host rootfs mounted rw |
| `fs` | 1c + filesystem-only persistence triggers | as `1c` | host calc-pop via cron/GPO/PS-profile |
| `7`  | `POST /containers/<id>/exec` with `{ "Privileged": true }` | proxy never inspected the exec body at all | all caps + device-cgroup allow-all → raw host disk |
| `mask` | `"MaskedPaths": [], "ReadonlyPaths": []` | both keys were on the allowlist and an empty array reads as "no meaningful value" | unmasks `/proc/kcore`, `/proc/sysrq-trigger` |

The same class also reached `/volumes/create` (a lowercase `driveropts` skipped
the bind-backed-volume check) and the ownership-label injection (a lowercase
`labels` could sit beside the proxy's injected `Labels` and spoof
`huddle.parent`).

## The fix — validate what the daemon honours

Three layers, applied to every body the proxy inspects and to `validateHostConfig`
/ `validateExecConfig` / `validateVolumeCreate`:

1. **Reject case-insensitive duplicate keys** (`findAmbiguousKey`), recursively,
   anywhere in the body. Fail-closed: a `Privileged`/`privileged` pair (either
   order) is refused rather than silently resolved. This also makes lowercasing
   lossless.
2. **Validate on a deep-lowercased view** (`deepLowerKeys`). Every guard now reads
   canonical lowercase field names, so it sees exactly what the daemon will honour
   regardless of the client's casing — including nested `Mounts[].type`,
   `VolumeOptions.DriverConfig`, and `PortBindings[].HostPort`.
3. **Canonicalize the keys the proxy injects into** (`renameKeyCI`): `HostConfig`,
   `Labels`, `Env`, `NetworkingConfig`/`EndpointsConfig`, `NetworkMode`, plus
   `Options`/`Labels` on network/volume create. A lowercase variant is renamed to
   the canonical key *before* injection, so the forwarded body never carries a
   second, daemon-merged copy.

Additionally:

- **Exec-create is now body-inspected** (`processExecCreate` + `validateExecConfig`):
  a privileged exec is refused, in any casing; an unparseable body fails closed.
- **`MaskedPaths` / `ReadonlyPaths` are hard-denied on presence** (any value,
  including an empty array). A spawned container has no legitimate need to weaken
  the daemon's secure defaults.

The pre-existing hard-denies (`Privileged`, `PidMode`, `VolumesFrom`,
`DeviceCgroupRules`, …) are unchanged in intent — they are simply now evaluated
against the lowercased view, so they can no longer be cased around. They remain
always-on, independent of the `HUDDLE_HOSTCONFIG_ENFORCE` allowlist flag.

## Behaviour change for reviewers

- `MaskedPaths` / `ReadonlyPaths` in a `containers/create` body are now rejected
  (previously allowed). Devcontainer child-container flows (compose/CLI) do not
  set these, so no legitimate workflow is expected to break. The `HUDDLE_HOSTCONFIG_ENFORCE`
  flag is unaffected by this — the deny is a hard-deny.
- Bodies containing case-insensitive duplicate keys are refused with
  `ambiguous duplicate … key not permitted`.

## Tests

`gateway/test/socket-proxy-parser-hardening.test.ts` covers each PoC vector as a
pure-function assertion (privilege denies in every casing, lowercase `Mounts.type`,
empty/shrunk `MaskedPaths`, ambiguous duplicate keys, lowercase `hostport`,
privileged exec, lowercase `driveropts`) plus the building blocks
(`findAmbiguousKey`, `deepLowerKeys`, `renameKeyCI`) and no-false-positive checks
for legitimate bodies. `gateway/test/host-config.test.ts` was updated to assert the
new `MaskedPaths`/`ReadonlyPaths` deny.

## Reproducing

The socket-level policy runs behind a live Docker socket and is out of scope for
the unit tests (see the note in `socket-proxy.test.ts`). To confirm end-to-end,
run the authorized `poc-suite.sh` from inside a devcontainer of your own Huddle
instance: each vector should now print `refused — finding closed on this instance`
and exit `2`.
