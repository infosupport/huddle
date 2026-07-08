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
