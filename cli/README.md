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
huddle fw list
huddle firewall list -i
```

Default API URL: `http://localhost:3000`. Override it with `--url` or `HUDDLE_URL`.

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
--name <name>
--image <image>
--empty
-i, --interactive
--container <name>
--status <requested|allow|deny>
```
