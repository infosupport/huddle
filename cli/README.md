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

## Making host folders selectable in the portal

Huddle's portal runs inside a container, so it cannot open a folder dialog on your
host: every host path had to be typed from memory. `huddle indexfolder` scans your
host once and stores what it finds, and every host-path field in the portal grows a
**Browse** button that opens those folders as a tree — starting a devcontainer, the
folder mappings, and the team-managed folders. Starting a devcontainer, Ctrl-click picks
several folders at once and each becomes its own worktree. Typing a path by hand keeps working:
the index is a snapshot, so a folder created after the last scan must not be
unreachable.

```bash
cd T:/projects
huddle indexfolder                  # this folder + 2 levels below it
huddle indexfolder T:/projects --depth 3
huddle indexfolder --all            # also index node_modules, dist, target, ...
huddle indexfolder --replace        # re-scan: drop the earlier entries under this folder first
huddle indexfolder --list           # show what is indexed
huddle indexfolder --clear          # empty the index (with a folder: only that subtree)
```

Hidden (dot) folders and the usual build folders (`node_modules`, `dist`, `target`,
`obj`, …) are skipped, which is what keeps a scan of a projects folder in the
hundreds instead of the tens of thousands; `--all` turns that off. The scan stops
at 1500 folders and the index holds at most 2000 — index a more specific folder if
you hit that.

The index is a **snapshot**, not a live view: the gateway cannot read your host, so
re-run the command after adding projects. Every input keeps accepting a typed path,
so a folder you created a minute ago works without re-indexing first. Windows paths
may be typed either way (`T:\projects\app` or `T:/projects/app`) — they are stored
in one canonical form, and the two spellings are the same entry.

Individual folders can also be added or removed under **Settings > Indexed
folders** in the portal. The index lives in Huddle's database, not in
`~/.huddle/config.json`: it describes this machine, so unlike the team-managed
settings it is not something to share in version control.

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
--name <name>
--image <image>
--empty
-i, --interactive
--container <name>
--status <requested|allow|deny>
```
