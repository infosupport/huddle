# Built from the repo root (context: .) so npm workspaces can resolve the
# single root lockfile — but each stage below only COPYs the workspace
# manifest(s) it actually needs, so gateway/frontend's and cli's toolchains
# and node_modules never enter the gateway image or even this Dockerfile's
# other stages.

FROM node:24-alpine AS frontend-builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY gateway/frontend/package.json ./gateway/frontend/
RUN npm ci --workspace=gateway/frontend --include-workspace-root
COPY gateway/frontend/angular.json gateway/frontend/tsconfig*.json ./gateway/frontend/
COPY gateway/frontend/src ./gateway/frontend/src
RUN npm run build --workspace=gateway/frontend
# Output lands at /app/gateway/dist/ui (angular.json outputPath: ../dist/ui)


FROM node:24-alpine AS gateway-builder
WORKDIR /app
RUN apk add --no-cache python3 make g++

# Manifests only — this layer is cached until root or gateway dependencies
# change, and never sees gateway/frontend's or cli's package.json at all.
COPY package.json package-lock.json ./
COPY gateway/package.json ./gateway/
RUN npm ci --workspace=gateway --include-workspace-root

COPY gateway/tsconfig.json ./gateway/
COPY gateway/src ./gateway/src
RUN npm run build:ts --workspace=gateway

# Drop devDependencies (typescript, vitest, @types/*) now that tsc has run.
RUN npm prune --omit=dev --workspace=gateway --include-workspace-root


FROM node:24-alpine AS runtime
WORKDIR /app
RUN mkdir -p /data /tmp/dc-sockets
COPY --from=gateway-builder /app/node_modules ./node_modules
COPY --from=gateway-builder /app/gateway/dist ./dist
COPY --from=frontend-builder /app/gateway/dist/ui ./dist/ui
COPY gateway/package.json ./
COPY gateway/extensions ./extensions
ENV DB_PATH=/data/huddle.db
ENV EXT_DIR=/app/extensions
EXPOSE 80 3000
CMD ["node", "dist/index.js"]
