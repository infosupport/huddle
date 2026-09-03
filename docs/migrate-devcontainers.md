# Migrating an existing Dev Container / Docker Compose project to Huddle

Already have a `.devcontainer/devcontainer.json` that uses `dockerComposeFile` with
several services (app, database, seed, dashboard, …) and start it with **"Dev Containers:
Clone Repository in Named Container Volume"**? You can keep that setup and route it through
the Huddle proxy without rewriting it.

`huddle migrate` generates a small Compose **override file** that wires your services behind
Huddle. Your own `docker-compose.yml`, `devcontainer.json`, extensions, features,
`initializeCommand`, `postCreateCommand` and forwarded ports all stay exactly as they are.

## How it works

Huddle's `devcontainer-net` network (created by `huddle init`) is **internal**: it has no
route to the internet of its own. The only way out is the Huddle proxy on `huddle:80`, which
enforces the firewall and terminates TLS with its own CA. So two things have to be true for a
service to reach the internet through Huddle:

1. It is attached to the internal `devcontainer-net` network.
2. Its egress goes through the proxy (`HTTP(S)_PROXY`) and it trusts the Huddle CA.

`huddle migrate` produces both for you, in an override file, so you never hand-write proxy
env vars, `NO_PROXY`, CA paths or socket mounts.

## The convention: mark one network

In your `docker-compose.yml`, add the label `huddle.network: "true"` to the (internal)
network your services already share. That is the **only** change you make to your own files —
it tells `huddle migrate` which services to wire.

```yaml
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: my-project-devcontainer
    command: sleep infinity
    networks: [development]
    depends_on: [db]

  db:
    image: mcr.microsoft.com/mssql/server:2019-latest
    networks: [development]

  dashboard:
    image: mcr.microsoft.com/dotnet/aspire-dashboard:latest
    networks: [development]

networks:
  development:
    internal: true            # required: no direct route to the internet
    labels:
      huddle.network: "true"  # Huddle wires every service on this network
```

> The network **must** be `internal: true`. If it is not, a service could reach the internet
> directly and bypass Huddle's firewall/proxy — `huddle migrate` warns when it sees this.

## Generate the override

From your project directory (where `docker-compose.yml` lives), with Huddle already running
(`huddle init`):

```bash
huddle migrate
```

This writes `docker-compose.huddle.yml` next to your compose file. For each service on the
marked network it adds, in the override only:

* the proxy env vars — `HTTP_PROXY` / `HTTPS_PROXY` (+ lowercase) `= http://huddle:80`;
* `NO_PROXY` including `huddle` (so the direct CA fetch to `huddle:3000` skips the proxy);
* `NODE_EXTRA_CA_CERTS` pointing at the CA path;
* a second network, `huddle`, that maps to the existing `devcontainer-net`
  (`external: true`) — your own `development` network is left untouched.

Example generated `docker-compose.huddle.yml`:

```yaml
services:
  app:
    networks:
      development:
      huddle:
    environment:
      HTTP_PROXY: "http://huddle:80"
      HTTPS_PROXY: "http://huddle:80"
      http_proxy: "http://huddle:80"
      https_proxy: "http://huddle:80"
      NO_PROXY: "localhost,127.0.0.1,::1,[::1],huddle"
      no_proxy: "localhost,127.0.0.1,::1,[::1],huddle"
      NODE_EXTRA_CA_CERTS: /home/vscode/.huddle-ca.crt
    volumes:
      - "/home/you/.huddle/ca/ca.crt:/home/vscode/.huddle-ca.crt:ro"
  # …db, dashboard likewise…
networks:
  huddle:
    external: true
    name: devcontainer-net
```

## Wire it into your project

`huddle migrate` only **generates** the override — it does not start anything. Three steps
to finish:

1. **Make sure Huddle is running** so `devcontainer-net` exists:

   ```bash
   huddle init
   ```

2. **Nothing to do for the CA** — the override bind-mounts it read-only from Huddle
   Node's data directory (`~/.huddle/ca/ca.crt`) onto the path in `NODE_EXTRA_CA_CERTS`.

   There is deliberately no endpoint to download it from: the CA lives on the host with
   Huddle Node, the gateway only gets it read-only, and giving containers a way to reach
   Huddle itself would be a route around the proxy. Use the home of your `remoteUser`;
   pass `--ca-path` to `huddle migrate` if it differs (e.g. `--ca-path
   /home/node/.huddle-ca.crt`). Run `huddle init` before the first `up` so the file the
   mount points at exists — Docker would otherwise create a *directory* there.

3. **Reference the override** so the IDE merges it when it (re)creates the containers. In
   `devcontainer.json`:

   ```jsonc
   "dockerComposeFile": ["docker-compose.yml", "docker-compose.huddle.yml"]
   ```

   Or start it yourself:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.huddle.yml up -d
   ```

You can keep using "Clone Repository in Named Container Volume" — the override is just an
extra Compose file the Dev Containers extension merges.

## Options

| Flag | Purpose |
| --- | --- |
| `--ca-path <path>` | Where the CA lands in the container (`NODE_EXTRA_CA_CERTS`). Default `/home/vscode/.huddle-ca.crt`. |
| `--docker-socket` | Also wire Huddle's filtered Docker socket + `DOCKER_HOST` (see below). |
| `--output <path>` | Write the override somewhere other than `docker-compose.huddle.yml`. |
| `--force` | Overwrite an existing override file. |

## Docker-in-Docker (`--docker-socket`)

If your outer devcontainer itself runs Docker (`docker compose up`, Testcontainers, …) it
must talk to Huddle's **filtered** socket, never the raw engine. `--docker-socket` generates
the mount (`/tmp/dc-sockets/<container_name>:/var/run/huddle`) and
`DOCKER_HOST=unix:///var/run/huddle/docker.sock` for each service that has a fixed
`container_name`.

Huddle is not in the IDE's create path for these containers, so `huddle migrate` also
registers each `container_name` with Huddle Node right away (`POST
/api/docker/register-socket`), before the container ever exists. The command waits for the
gateway to confirm it has bound the filtered socket at that name-keyed path; only then does
it report success, so `docker compose up` sees a live socket instead of an empty directory.
Requires Huddle to be running (`huddle init`) when you run `huddle migrate --docker-socket`;
if Node or the gateway cannot confirm readiness, the command still writes the override but
warns, and you should re-run `huddle migrate --docker-socket --force` once it is healthy.

The proxy/CA/network wiring (the default, without `--docker-socket`) works the same way; it
is the same pattern the Huddle repository's own [`.devcontainer/`](../.devcontainer) uses.

## Security requirements

* The marked network **must** be `internal: true`.
* A wired service **must not** also be attached to a second, non-internal network — that
  would be an unfiltered route out. `huddle migrate` warns on both.
* Do not grant the container `NET_ADMIN`; it could otherwise tear down the injected routing.
