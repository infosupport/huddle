# huddle-gateway — the network enforcement point, and nothing else.
#
# This image used to be all of Huddle. It is now one half: the filtering proxies
# devcontainers are DNAT'ed to. The portal, the API, the database and the Docker
# orchestration run as Huddle Node on the host (docs/ADR-huddle-node-split.md).
#
# What is NOT in here is the point of the split: no frontend, no /data volume,
# no Docker socket. The half of Huddle a devcontainer can reach should be able to
# do as little as possible.

FROM node:24-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

# TypeScript only — `npm run build` would also build the Angular portal, which
# this image no longer serves.
COPY src ./src
RUN npm run build:ts

RUN npm prune --omit=dev


FROM node:24-alpine AS runtime
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
# No `sbx` here on purpose: Docker Sandboxes is a HOST binary, driven by Huddle
# Node on the host. The image used to bake a file-mailbox shim onto the PATH that
# forwarded argv to a watcher on Windows; that bridge is gone (step 5 of
# docs/ADR-huddle-node-split.md).

# The role IS the deployment (src/runtime-env.ts). Without this the process would
# start as Huddle Node — the default a bare `node dist/index.js` on a developer's
# machine should have — and open an API this image has no business serving.
ENV HUDDLE_ROLE=gateway
# Node generates the CA and owns it; this half only signs leaf certs with it and
# gets the directory bind-mounted read-only here.
ENV CA_DIR=/ca
EXPOSE 80 32768
CMD ["node", "dist/index.js"]
