# Build-context is de repo-root (niet ./gateway), zodat de base-devimage
# Dockerfiles mee de image in kunnen. Bouwen met:
#   docker build -f gateway/Dockerfile -t huddle .
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++

# Install gateway deps
COPY gateway/package.json gateway/package-lock.json gateway/tsconfig.json ./
RUN npm ci

# Install Angular frontend deps
COPY gateway/frontend/package.json gateway/frontend/package-lock.json ./frontend/
RUN npm ci --prefix frontend

# Copy source and build
COPY gateway/src ./src
COPY gateway/frontend/src ./frontend/src
COPY gateway/frontend/angular.json gateway/frontend/tsconfig*.json ./frontend/
RUN npm run build

# Remove devDependencies so only production node_modules remain
RUN npm prune --omit=dev


FROM node:20-alpine AS runtime
WORKDIR /app
RUN mkdir -p /data /tmp/dc-sockets
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY gateway/package.json ./
COPY gateway/extensions ./extensions

# Base-devimage Dockerfiles meebakken zodat de gateway ze on-demand kan bouwen,
# ook zonder repo-checkout (npm-installatie via `huddle init`). De read-only
# mounts uit init.sh overschrijven deze paden tijdens lokale ontwikkeling.
COPY base-devimage/Dockerfile /base-devimage/Dockerfile
COPY base-devimage-intellij/Dockerfile /base-devimage-intellij/Dockerfile
COPY base-devimage-rider/Dockerfile /base-devimage-rider/Dockerfile
COPY base-devimage-vscode/Dockerfile /base-devimage-vscode/Dockerfile

ENV DB_PATH=/data/huddle.db
ENV EXT_DIR=/app/extensions
EXPOSE 80 3000
CMD ["node", "dist/index.js"]
