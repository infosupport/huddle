---
name: docker
description: Docker container management and compose workflows
tools: Bash
model: sonnet
---

# Docker Skills

## Docker — Starting & Testing Applications

You have access to `docker`, a sandbox-aware wrapper for managing Docker containers in your isolated sandbox network. Use this to start databases, run application servers, or spin up any service you need for development and testing.

> **In Huddle, Docker access is time-boxed**: if `docker` commands are denied, ask the user/operator to grant Docker access in the Huddle UI rather than retrying. Grants are temporary (e.g. 15 min); outside a grant, docker commands are denied.

### Quick Start

```bash
# Start a container (e.g. a Node.js app on port 3000)
docker run -p 3000 -d node:20 npm start

# Start a PostgreSQL database
docker run -p 5432 -e POSTGRES_PASSWORD=secret -d --name db postgres:16

# Start Redis
docker run -p 6379 -d --name cache redis:7-alpine

# Check running containers
docker ps

# View container logs
docker logs db
docker logs --tail 50 db

# Show port mappings (get the external URL to access the app)
docker port db

# Stop / start / remove containers
docker stop db
docker start db
docker rm db
```

### Docker Compose

For multi-service applications, use Docker Compose:

```bash
# Start all services defined in docker-compose.yml
docker compose up -d

# Use a specific compose file
docker compose up -d -f ./infra/docker-compose.yml

# List compose services
docker compose ps

# Tear down all compose services
docker compose down
```

### Key Details

- **Time-boxed access**: In Huddle, Docker access is granted temporarily by an operator in the Huddle UI. Outside a grant, docker commands are denied — request a grant instead of retrying.
- **Isolation**: You can only manage your own containers. Each agent has a separate Docker network.
- **Ports**: Use `-p PORT` to expose container ports. The platform assigns an external host port automatically — use `docker port` to see the mapping.
- **Naming**: Use `--name` to give containers recognizable names for easier management.
- **Detach**: Always use `-d` for long-running services (databases, servers) so they run in the background.
- **Environment**: Use `-e KEY=VALUE` (repeatable) to pass environment variables.
- **Images**: Common images are available: `node`, `python`, `postgres`, `mysql`, `redis`, `nginx`, `httpd`, `mongo`, `alpine`, `ubuntu`.

### Typical Workflow

1. Read the project's docker-compose.yml or README for required services
2. Start dependencies first (databases, caches) with `docker run` or `docker compose up`
3. Verify they're running with `docker ps`
4. Get access URLs with `docker port <name>`
5. Start the application and test it
6. Check logs if something fails: `docker logs <name>`
