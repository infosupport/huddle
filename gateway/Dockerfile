FROM node:20-alpine AS builder
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


FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache python3 make g++ \
    && mkdir -p /data /tmp/dc-sockets /app
COPY package.json ./
RUN npm install --omit=dev \
    && apk del python3 make g++
COPY --from=builder /app/dist ./dist
COPY extensions ./extensions
ENV DB_PATH=/data/huddle.db
ENV EXT_DIR=/app/extensions
EXPOSE 80 3000
CMD ["node", "dist/index.js"]
