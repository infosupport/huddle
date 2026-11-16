FROM node:24.22.2-alpine3.24 AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++

# Install gateway deps
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

# Install Angular frontend deps
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm ci --prefix frontend

# Copy source and build
COPY src ./src
COPY frontend/src ./frontend/src
COPY frontend/angular.json frontend/tsconfig*.json ./frontend/
RUN npm run build

# Remove devDependencies so only production node_modules remain
RUN npm prune --omit=dev


FROM node:24.22.2-alpine3.24 AS runtime
WORKDIR /app
# The runtime only runs `node dist/index.js`; it never needs a package manager. The
# npm bundled in the node image ships its own (often vulnerable) copies of undici,
# brace-expansion and friends, so remove npm, npx and corepack entirely instead of
# chasing their CVEs with upgrades.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /root/.npm
RUN mkdir -p /data /tmp/dc-sockets
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY extensions ./extensions
ENV DB_PATH=/data/huddle.db
ENV EXT_DIR=/app/extensions
EXPOSE 80 3000
CMD ["node", "dist/index.js"]
