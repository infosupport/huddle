# Huddle Security Verification

You are an agent running inside a **fresh** devcontainer attached to Huddle. This file is your test plan. Run each test, compare the actual output to "Expected", and report PASS / FAIL with the observed output. End with a one-paragraph summary.

Do NOT skip tests, do NOT delete this file, do NOT try to "fix" failing tests yourself — your job is to verify and report.

## Prior run — 2026-05-26 (read this before starting)

A previous agent ran this plan and found a **critical sandbox escape**:

- `huddle/gateway/src/socket-proxy.ts` injected `huddle.parent` label + `NetworkMode: dc-net-*` into every `POST /containers/create` body, but did **not** filter the rest of `HostConfig`.
- Verified honored end-to-end with a Docker grant: `--privileged`, `--pid=host`, `--cap-add=SYS_ADMIN`, `-v /:/host`, `-v /var/run/docker.sock:/var/run/docker.sock`, `-v /etc:/host-etc`.
- Concrete impact: from inside a devcontainer with a Docker grant, `-v /:/host` exposed the host's `/etc/shadow` and `/proc/1/cmdline = /sbin/init`. The docker.sock mount let a sibling container spawn `--privileged --pid=host -v /:/hostroot` with **no `huddle.parent` label** — fully outside huddle's tracking.
- Only `--network=host` was correctly neutralised (overridden to `dc-net-<container>`).

**Fix landed:** `validateHostConfig()` in `socket-proxy.ts` now 403s `POST /containers/create` bodies that contain Privileged / PidMode / IpcMode=host / UsernsMode=host / CgroupnsMode=host / UTSMode=host / CgroupParent / non-empty CapAdd / non-empty Devices / non-empty Sysctls / dangerous SecurityOpt entries / any `Binds` with a host-path source / any `Mounts` with `Type: "bind"`. Unparseable JSON bodies now also 403 (previously bypassed label injection).

**Out-of-scope for the fix (potential follow-ups, do not test as failures):**
- `POST /containers/{id}/exec` body — `Privileged: true` on exec is not validated. Bounded by the container's existing HostConfig, so low risk after this fix.
- `POST /build` query params — image build, no persistent HostConfig.
- `POST /containers/{id}/update` — not in the route allow-list anyway (falls through to deny).

**Run T11 (added below) to verify the fix.** If T11 fails, the fix has regressed — flag, do not try to re-fix yourself.

## Resetting before a re-run

- To deploy a freshly-built huddle: restart only the `huddle` container. The per-container socket proxy is recreated on attach; the devcontainer itself does not need to restart (the docker.sock may flap for a moment).
- For a clean baseline (the "fresh devcontainer" assumption the rest of this file makes): rebuild this devcontainer **and** remove any leftover containers labeled `huddle.parent=<this-devcontainer-name>` from prior sessions. The previous run noted one straggler named `pensive_lederberg`. Check with `docker ps -a --filter label=huddle.parent=<this-devcontainer-name>` (needs a Docker grant).

## Context you need

```bash
# Identify yourself
echo "container: $HOSTNAME"
echo "user: $(whoami)"
```

Most tests do not need a Docker grant. **T9** does — if you don't have one, mark it SKIPPED and ask the user to grant Docker access via the Huddle UI before running it.

`--noproxy huddle` on curl means "ignore http_proxy for this host" — used to verify the direct path from the API itself, bypassing the gateway, so we can confirm both layers work.

---

## T1 — Per-container socket mount

```bash
ls -la /var/run/docker.sock
ls -la /tmp/dc-sockets/ 2>&1 || echo "directory not visible — good"
```

**Expected:** `/var/run/docker.sock` exists as a socket file (no longer a symlink). `/tmp/dc-sockets/` should **not exist** as a directory inside the container.

---

## T2 — `docker ps` shows only own spawns

```bash
docker ps -a
```

**Expected:** Without a Docker grant: `authorization denied by policy` — the stricter version of "empty list", still PASS. With a Docker grant: only containers labeled `huddle.parent=<your-container-name>` appear; nothing else from the host. If you see a stray container that you didn't spawn this session (e.g. `pensive_lederberg` from a prior run), check its `huddle.parent` label via `docker inspect` — if the label matches your container name, it's a leftover from a previous attach (note it, still PASS); if not, that's a real isolation breach.

---

## T3 — Inspect of a foreign container denied

Pick something that definitely exists on the host (the huddle container itself):

```bash
docker inspect huddle 2>&1 | head -5
```

**Expected:** Error / `403` / `container not owned by this devcontainer` (or `inspect of devcontainer not permitted`). The actual JSON config of the huddle container must not be returned.

---

## T4 — Management API is unreachable from devcontainer-net

These bypass the gateway and hit the API directly. The API source-IP gate should refuse them:

```bash
for path in /api/health /api/grants /api/audit /api/rules /api/containers; do
  code=$(curl -s -o /tmp/r --noproxy huddle -w "%{http_code}" "http://huddle:3000${path}")
  body=$(cat /tmp/r | head -c 200)
  echo "GET ${path} → HTTP ${code}  body=${body}"
done
```

**Expected:** Every line is `HTTP 403` with body containing `endpoint not allowed from devcontainer network`.

---

## T5 — Sudo audit endpoint IS reachable

The one whitelisted path:

```bash
curl -s --noproxy huddle -X POST http://huddle:3000/api/audit/sudo \
  -H "Content-Type: application/json" \
  -d '{"entry":"T5: manual probe from verification agent"}'
echo
```

**Expected:** `{"ok":true}`. The user can confirm in the Huddle UI audit log that an entry appeared, attributed to **your** container name.

---

## T6 — Sudo audit: identity spoofing rejected

Try to log a sudo entry while claiming you're a different container:

```bash
curl -s --noproxy huddle -X POST http://huddle:3000/api/audit/sudo \
  -H "Content-Type: application/json" \
  -d '{"container":"huddle","entry":"T6: SPOOF — claiming to be huddle itself"}'
echo
```

**Expected:** `{"ok":true}` — BUT in the Huddle audit log the entry must appear under your own container, not `huddle`. The body's `container` field must be ignored. Ask the user to verify in the UI.

---

## T7 — Gateway path-whitelist for the huddle domain

This goes **through** the http proxy (no `--noproxy`), so the gateway sees the request and applies its own check before forwarding:

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

## T8 — HTTPS CONNECT to huddle blocked

```bash
curl -sv --noproxy huddle https://huddle:3000/ 2>&1 | head -10
# and via proxy
curl -sv https://huddle:3000/ 2>&1 | grep -i "connect\|forbidden\|huddle-internal" | head -5
```

**Expected:** Direct HTTPS fails (no TLS). Via proxy, CONNECT is rejected with `403 huddle-internal endpoint not allowed`.

---

## T9 — Container spawn forces network + label (needs Docker grant)

**Pre-condition:** Ask the user via the Huddle UI to grant Docker access (any duration). If they refuse or grant is unavailable, mark this SKIPPED.

```bash
docker run -d --name t9-spawn alpine sleep 3600
docker inspect t9-spawn | grep -E '"NetworkMode"|"huddle.parent"' | head -5
docker rm -f t9-spawn
```

**Expected:**
- `NetworkMode` is `"dc-net-<your-container-name>"` — not `bridge` and not `host`
- Labels include `"huddle.parent": "<your-container-name>"`

---

## T10 — huddle is in the global allow rules

(Ask the user) In the Huddle UI → Firewall, look for a row with:
- domain: `huddle`
- container: (global / empty)
- status: `allow`

**Expected:** It exists. If it does not, the `INSERT OR IGNORE` seed in `initDb()` did not run — flag it.

---

## T11 — HostConfig escape vectors are rejected (needs Docker grant)

**Pre-condition:** same as T9 — needs a Docker grant. If unavailable, mark SKIPPED.

Each request below tries to create a container with one dangerous HostConfig field. The expected outcome for every one is `HTTP 403` with a reason string from `validateHostConfig()`. **None of these containers should ever be created.**

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
- The benign sanity run: container is created, `NetworkMode = dc-net-<your-container-name>`, `Binds = null`, `Privileged = false`.
- If any escape-vector request returns `201` (created) instead of `403`, the fix has regressed — **flag it as a P0 finding and stop**, do not exploit further.

---

## Reporting

Produce a final table:

| Test | Status | Notes |
|------|--------|-------|
| T1 …  | PASS / FAIL / SKIPPED | one-line observation |

End with a one-paragraph summary: which layer caught what, anything unexpected, anything you couldn't verify alone (e.g., audit log entries — those need the user to check the UI).
