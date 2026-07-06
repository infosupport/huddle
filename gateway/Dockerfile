FROM node:24-alpine AS builder
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


FROM node:24-alpine AS runtime
WORKDIR /app
RUN mkdir -p /data /tmp/dc-sockets
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY extensions ./extensions
ENV DB_PATH=/data/huddle.db
ENV EXT_DIR=/app/extensions
EXPOSE 80 3000
CMD ["node", "dist/index.js"]
