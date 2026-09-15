# POC: IDEs installed at runtime into slim SSH containers

No IDE in the image. The image is a slim Debian + sshd + a non-root user. The
IDE — **IntelliJ IDEA**, **Rider** or **OpenVSCode Server** — is downloaded and
installed **at container start**, and the script hands you a way to connect.

This is the shape that would replace the current
`base-devimage-{intellij,rider,vscode}` image matrix with one slim base.

## Files

| file | what it is |
|---|---|
| `Dockerfile` | slim `debian:trixie-slim` + `openssh-server` + non-root `dev` user. No IDE. |
| `entrypoint.sh` | sets the `dev` password, generates host keys, runs `sshd -D` |
| `install-ide.sh` | runs *inside* the container as `dev`: downloads the IDE, installs plugins, starts it |
| `run-poc.sh` | the driver: build → start → provision → connect info |

## Run it

```bash
./run-poc.sh                 # intellij (default)
./run-poc.sh rider
./run-poc.sh vscode
./run-poc.sh all             # all three, side by side

./run-poc.sh intellij IdeaVIM org.sonarlint.idea    # your own plugin list
./run-poc.sh --ports         # which port belongs to which IDE
./run-poc.sh --links rider   # every link that IDE published
./run-poc.sh --stop          # tear all three down
```

## One port per IDE

All three can run at the same time; nothing collides.

| IDE | SSH | web | container | cache volume |
|---|---|---|---|---|
| `intellij` | 2222 | — | `huddle-poc-intellij` | `huddle-poc-cache-intellij` |
| `rider` | 2223 | — | `huddle-poc-rider` | `huddle-poc-cache-rider` |
| `vscode` | 2224 | 3000 | `huddle-poc-vscode` | `huddle-poc-cache-vscode` |

Each IDE gets its own cache volume. The JetBrains dists could safely share one
(`idea-*` vs `JetBrains.Rider-*` are distinct directories), but two backends
writing the same `~/.cache` concurrently is a race a POC does not need.

## Credentials: there are none

**No SSH keys anywhere.** The image sets `PubkeyAuthentication no` and
`run-poc.sh` never generates a keypair. Every key-related failure in this POC
came from moving a key file between the container, WSL and the host, so the key
is gone.

```
user      dev
password  dev            # DEV_PASSWORD=... to change, DEV_PASSWORD="" for none
```

In JetBrains Gateway, leave **"Specify private key" unchecked** and type the
password.

> **Local POC only.** A well-known or blank password on an SSH server is fine
> while the port is published to localhost on one developer machine and nothing
> else. A Huddle sandbox reachable from anywhere else must go back to key-only
> auth: drop the `PasswordAuthentication` / `KbdInteractiveAuthentication` /
> `PermitEmptyPasswords` lines in the Dockerfile, set `PubkeyAuthentication
> yes`, and inject the per-sandbox public key.

### How the provisioning gets in

Without a key there is no way to feed a password to `ssh` non-interactively, so
`run-poc.sh` uses SSH when `sshpass` is installed and falls back to
`docker exec -u dev` when it is not. It prints which one it picked. Both run as
the non-root `dev` user and both drive the same `install-ide.sh`, so the
install under test is identical — only the transport differs. In real Huddle
the host-side agent would use the `docker exec` path anyway; SSH is what the
*developer's* IDE client uses.

## Connecting

**IntelliJ / Rider** — the backend prints a `jetbrains-gateway://connect#…`
link. That is a protocol-handler link, **not an http URL**: it only resolves if
Gateway or Toolbox is installed and has registered the scheme. Paste it into
the Windows Run dialog (Win+R), or skip it and connect Gateway over SSH —
`install-ide.sh` runs `registerBackendLocationForGateway`, so the backend shows
up without Gateway downloading anything.

**VS Code** — no SSH hop needed, openvscode-server serves the editor itself:

```
http://localhost:3000/?folder=/workspace
```

Started with `--without-connection-token`, so anyone who can reach the port
gets in. POC only.

## Can credentials go into the Gateway link?

**No.** There is no key or password parameter in the scheme. Checked against
JetBrains Gateway 2026.2.2 (`GW-262.10315.114`) rather than the docs, which
document only a subset.

`SshGatewayConnectionProvider` hands the link's parameters to
`SshMultistagePanelContext.fromParameters`, and the validator in
`RunInstalledDetails` requires exactly:

```
type=ssh                          (rejected otherwise)
projectPath
deploy=false                      ("Invalid ssh link parameters: deploy should be false")
idePath   OR   productCode + buildNumber
```

plus `host`, `port`, `user` for the connection, and one the docs never mention:

```
sshId       names a connection Gateway has already saved
```

`sshKeyPath` does not appear anywhere in the installation. `keyPath`,
`privateKeyFile`, `authType` and `passphrase` do exist, but only in the SSH
config model and the credentials dialog — fields Gateway persists and prompts
for, never link parameters. Which is the right design: a link is a URL, and
URLs get pasted into chats and shell history.

`sshId` is the way to a genuine one-click link. Save the connection in Gateway
once, then:

```bash
SSH_ID="huddle poc" ./run-poc.sh
```

The link gets `&sshId=huddle%20poc` appended and Gateway reuses the saved
connection. Untested here — the parameter set is read off Gateway's bytecode,
not from a successful connection.

---

## What is verified, and what is not

The container half **has not been executed in this environment**: the sandbox's
proxy blocks `registry-1.docker.io` and `deb.debian.org`, so `docker build`
cannot pull `debian:trixie-slim` or run `apt-get`. Step 0 of `run-poc.sh`
detects exactly that and names the blocked hosts. On a developer machine with
normal egress the build succeeds — a 215 MB image, measured before the Rider
dependencies were added.

Everything that does not need the container was run for real against
**IntelliJ IDEA Ultimate 2026.2.2** (`IU-262.10315.125`), as a non-root user,
through a proxy. Those results are what the scripts were written from — not the
docs, which are wrong in two places.

### Verified (IntelliJ)

- **Download endpoint.** `https://download.jetbrains.com/product?code=IIU&latest=true&distribution=linux`
  302s to the current build. One host, no hardcoded build number.
  IntelliJ 1.5 GB in 4m44s; Rider 2.2 GB in 6m00s (~5–6 MB/s through the proxy).
- **Unpacked size / extract time.** 4.3 GB unpacked, 17s to extract.
- **Plugins install non-interactively as non-root.** 3 plugins in 34s, a 4th in 2.7s.
- **Plugins are actually loaded and enabled.** From the running backend's `idea.log`:
  ```
  Loaded custom plugins: SonarQube for IDE (12.8.0.85170), IdeaVim (2.46.2),
                         GitToolBox (600.3.4+261), Key Promoter X (2026.1.2)
  ```
- **Backend starts and publishes links.** `jetbrains-gateway://…` after ~4s;
  `tcp://127.0.0.1:5991#jt=…` join link and plugins loaded by ~20s.
- **Plugin payload is not small.** 287 MB of cached plugin zips plus 426 MB
  unpacked for four plugins — SonarQube for IDE alone pulls 209 MB of analyzers.

### Not verified

- **Rider's backend.** The tarball downloads (2.2 GB, 6m00s) but the backend
  was never started. Rider bundles its own .NET, which links against the OS's
  ICU/OpenSSL/zlib, so the Dockerfile installs `libicu76 libssl3 zlib1g
  libstdc++6 libgssapi-krb5-2`. That list is reasoned, not measured — if the
  Rider backend dies shortly after start, this is the first place to look.
- **VS Code / openvscode-server.** Blocked hardest here: `github.com` needs
  Huddle portal approval and `open-vsx.org` is default-denied. The
  `--install-extension` flag and the Open VSX registry are the documented
  mechanism, but nothing in this flow has been run.
- **Connecting a real client.** Needs a GUI outside the sandbox. The IntelliJ
  backend was confirmed to publish a valid join link and load its plugins,
  which is as far as a headless environment goes.
- **`sshId`** and the exact size of the image now that Rider's dependencies are in.

### Two documentation bugs this POC works around

1. **`installPlugins` no longer takes a project path.** The docs say
   `remote-dev-server.sh installPlugins PROJECT_PATH pluginId`. In 2026.2 the
   path is parsed as a plugin ID:
   ```
   looking up plugins: [/var/lib/.../workspace/demo, Key Promoter X]
   unknown plugins: [/var/lib/.../workspace/demo]
   ```
   It still exits 0, so a script following the docs fails silently. The correct
   form is `installPlugins <pluginId>...`.

2. **The dev-container prerequisite list is stale.** The docs list `libxext`,
   `libxrender`, `libxtst`, `libxi`, `freetype`, `gcompat` as required. As of
   2026.2 the backend ships its own copies in
   `plugins/remote-dev-server/selfcontained/lib` (35 MB: libX11, libXext,
   libXrender, libXtst, libXi, libfreetype, libfontconfig, wayland, NSS …) and
   uses them **by default**. Its `launcher.sh` says so outright:
   ```
   # Patch JBR to make self-contained JVM (requires nothing from host
   # system except glibc)
   ```
   So the image installs none of them — only `curl`, `tar`, `gzip`, `procps`,
   `git`, `ca-certificates`, which is what the launcher shells out to.

   Setting `REMOTE_DEV_SERVER_USE_SELF_CONTAINED_LIBS=0` means adding them back.

### Answers to the three questions

**Is a slim glibc base sufficient?** For IntelliJ, yes, and more so than
expected — the backend needs nothing from the OS but glibc plus a handful of
CLI tools. Rider is the open question, because its bundled .NET does reach for
OS libraries.

**Is Alpine/musl viable?** No, and it fails in a way worth knowing about.
`remote-dev-server.sh` and `launcher.sh` both probe for musl three ways
(`gcompat ELF interpreter stub`, `getconf GNU_LIBC_VERSION`, `ldd --version |
grep musl`). On a musl host it does not error — it silently switches off both
the native launcher (`# new launcher doesn't work with musl yet`) *and* the
self-contained libs, so every bundled library must then come from the OS. It
degrades quietly rather than failing loudly.

**Does backend caching on a shared volume make second starts acceptable?**
Yes, for the part that dominates. `install-ide.sh` probes for
`bin/remote-dev-server.sh` and skips download+extract on a hit, so a warm start
drops the ~5 minute download and the 17s extract. Two caveats found in
`launcher.sh`:
- it copies and rewrites `jbr/` into a temp dir on **every** start, so the
  volume cannot be mounted read-only;
- the cache is keyed by build number, so an IDE upgrade is a full cold start —
  worth pre-warming rather than letting the first developer of the day pay.

**Is the backend-only plugin limitation a real problem?** Not for the plugins
tested. SonarQube for IDE, IdeaVim, GitToolBox and Key Promoter X all loaded
and ran server-side with no client-side half. The limitation bites plugins that
ship UI the thin client has to render; none of these four do. Needs a check
against the actual Info Support plugin list before it can be called settled.

## Hosts to allowlist

Verified reachable and required for the JetBrains flows:

| host | why |
|---|---|
| `download.jetbrains.com` | backend tarball (302 via CloudFront) |
| `plugins.jetbrains.com` | Marketplace API + `pluginManager` download entrypoint |
| `downloads.marketplace.jetbrains.com` | plugin binaries (302 target, S3) |

Needed for the VS Code flow:

| host | why |
|---|---|
| `github.com` | openvscode-server release redirect |
| `objects.githubusercontent.com`, `release-assets.githubusercontent.com` | the release asset itself |
| `open-vsx.org` | extension registry API |
| `openvsxorg.blob.core.windows.net` | extension `.vsix` binaries |

Needed to build the image at all:

| host | why |
|---|---|
| `registry-1.docker.io`, `auth.docker.io` | pull `debian:trixie-slim` |
| `deb.debian.org` | `apt-get install openssh-server …` |

## Troubleshooting

**`could not run commands in huddle-poc-<ide>`.**
Check `docker logs huddle-poc-<ide>` — the entrypoint prints the password it
set. If the transport is `ssh`, `sshpass` is being used with `$DEV_PASSWORD`;
if it printed `exec`, the failure is `docker exec`, not SSH at all.

**Gateway says "invalid credentials".**
Leave "Specify private key" unchecked and type the password (`dev`). The image
has `PubkeyAuthentication no`, so a key can never work here.

**`docker logs` shows `drop connection … penalty: failed authentication`.**
OpenSSH's `PerSourcePenalties` rate-limited the client IP. The Dockerfile
disables it, and `run-poc.sh` waits for the TCP port before attempting auth.
If you hit it anyway, `--stop` and re-run: a fresh container has no penalty
state.

**The `jetbrains-gateway://` link does nothing / `ERR_SSL_PROTOCOL_ERROR`.**
It is a protocol-handler link, not an http URL — a browser tries to speak TLS
to a host called `connect`. Use Win+R, or connect Gateway over SSH instead.

**Preflight says the container registry is blocked but the build works.**
Docker Hub answers `401` on `/v2/` without a token, which means reachable. 401
and 403 are treated as reachable.

**Gateway on Windows cannot reach `localhost:2222`.**
The port is published inside WSL rather than on Windows. Get the address with
`wsl hostname -I` and re-run so the generated link matches:
`LINK_HOST=<that-ip> ./run-poc.sh`.

## Notes on the constraints

- **Never root.** The `dev` user has no sudo and is in no admin group.
  `install-ide.sh` refuses to run as uid 0 (the backend forks the developer's
  shell, so a root backend is a root developer session). `run-poc.sh` asserts
  `id -u != 0` inside the container before installing. `sshd` itself runs as
  root — it has to — but `PermitRootLogin no` and `AllowUsers dev` mean nothing
  else can.
- **No local Docker CLI for the developer.** `run-poc.sh` is what Huddle's
  host-side agent runs. The developer needs only a Gateway client, or a
  browser for the VS Code flow.
- **SSH auth is deliberately weak, and only here.** See "Credentials" above.
