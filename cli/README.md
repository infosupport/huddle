# Huddle CLI

Cross-platform Node CLI for Huddle. The CLI talks to the existing Huddle REST API; container management and firewall resolution therefore live in the gateway, not re-implemented in the command client.

## Installing

The packages are public, so you don't need a GitHub token or registry login.

```bash
npm install -g @infosupport/huddle-cli
```

## Starting Huddle

```bash
huddle init
```

Pulls `ghcr.io/infosupport/huddle:latest` and starts the container. Works with Docker and Podman: the runtime is detected automatically (Docker first, then Podman), or pick one explicitly with `huddle init --runtime <docker|podman>` or the `HUDDLE_RUNTIME` env var. If you run `huddle` while Huddle isn't running, you automatically get a hint to run this command.

## Starting devcontainers

```bash
huddle                 # start an IntelliJ devcontainer for the current directory
huddle ./project       # start for a specific directory
huddle --ide rider
huddle --ide vscode --name devcontainer-demo
huddle --ide vscode --mount ../docker-corpa=/workspaces/backend --mount ../frontend-real-estate-info=/workspaces/frontend --name corpa-dev
huddle fw list
huddle firewall list -i
```

`--mount <host>=<container>` mounts an additional folder, worktree-isolated like the main workspace, at the container path you choose. The left side is a host path (relative paths are resolved against the current directory); the right side must be an **absolute** container path. Repeatable — pass one per folder — and cannot be combined with `--workspace`/`--empty`. Two mounts may not target the same container path.

`--workspace-root <path>` sets the absolute container path the IDE opens as its project root. It requires at least one `--mount`. Without it the root defaults to the deepest directory the mount targets share, so the example above opens `/workspaces` and shows `backend/` and `frontend/` inside it. Mount targets that share nothing fall back to `/workspaces`.

```bash
huddle --ide vscode \
  --mount ../ai-context-repo=/workspaces/ai \
  --mount ../backend-repo=/workspaces/backend \
  --mount ../frontend-repo=/workspaces/frontend \
  --workspace-root /workspaces --name corpa-dev
```

Default API URL: `http://localhost:24842` — Huddle Node, on the host. Override it with
`--url` or `HUDDLE_URL`.

## Selecting host folders in the portal

A browser cannot hand a server a folder path, so every host-path field in the portal
grows a **Browse** button that opens Huddle's own folder dialog — starting a
devcontainer, the folder mappings, and the team-managed folders. Ctrl-click picks
several folders at once when starting a devcontainer, and each becomes its own
worktree.

It browses your host live: Huddle Node runs there and lists one folder per request as
you open them, so a project you cloned a minute ago is simply in the list. There is
nothing to index and no CLI command to run first. Hidden (dot) folders are left out of
the listing; typing one still works, because every input keeps accepting a path you
type or paste.

Windows paths may be typed either way (`T:\projects\app` or `T:/projects/app`) —
Huddle stores one canonical form, so the two spellings are the same folder.

## Starting sandboxes (Docker Sandboxes / sbx)

```bash
huddle sbx start                                    # sandbox for the current directory
huddle sbx start my-box --workspace T:\projects\app  # a specific folder
huddle sbx start my-box \
  --workspace T:\projects\app \
  --folder T:\projects\shared-lib \
  --folder T:\docs:ro                               # extra folders, one read-only
```

`--workspace <path>` is the folder the agent starts in. `--folder <host path>` adds
another folder and is **repeatable**; append `:ro` to mount that folder read-only.
Unlike `--mount` for devcontainers there is no container path to choose: sbx mounts
every folder inside the sandbox at the same path it has on the host (a Windows path
`T:\projects\app` becomes `/t/projects/app`).

The **folder mappings** from Settings (the settings folders devcontainers get, e.g.
`~/.claude`) are added to every sandbox automatically: each one rides along as an
extra folder and is then linked at the path the agent reads it from. An existing
folder in the sandbox is never overwritten — only its missing entries are linked in,
so the agent credentials sbx manages itself stay untouched. Mappings that cannot
travel (a Docker volume, or a `~`/relative host path) are reported per sandbox
instead of silently dropped.

## Experiments

An experiment is a complete Huddle version (CLI + all Docker images) tied to a single GitHub issue. Push a branch `experiment/<issue-number>-<description>` and the pipeline publishes everything under the tag `experiment-<issue-number>`, fully separated from the normal releases.

```bash
huddle init --experiment 123   # activate the experiment and run init
huddle experiment use 123      # same as above
huddle experiment status       # show the active channel and CLI version
huddle experiment reset        # back to the stable release
```

On activation the CLI stores the experiment in `~/.huddle/config.json`, reinstalls itself as `@infosupport/huddle-cli@experiment-123`, restarts itself, and then runs `huddle init` with the `experiment-123` Docker images. So the CLI and the images always run on exactly the same version.

The experiment stays active — including on the next `huddle init` — until you explicitly run `huddle experiment reset`. That removes the local experiment config, reinstalls the stable CLI, and from then on `huddle init` uses the `latest` images again.

## Development

```bash
npm install
npm run build
npm run install-global
```

Main flags:

```text
--ide <intellij|rider|vscode>
--workspace <path>
--mount <host>=<container>   (repeatable, container path must be absolute)
--workspace-root <path>      (container path the IDE opens; requires --mount)
--folder <host path>[:ro]    (repeatable; extra sandbox folder for `huddle sbx start`)
--name <name>
--image <image>
--empty
-i, --interactive
--container <name>
--status <requested|allow|deny>
```
