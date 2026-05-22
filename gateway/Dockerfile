FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build


FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache python3 make g++ \
    && mkdir -p /data /tmp/dc-sockets /app
COPY package.json ./
RUN npm install --omit=dev \
    && apk del python3 make g++
COPY --from=builder /app/dist ./dist
COPY src/ui ./dist/ui
ENV DB_PATH=/data/huddle.db
EXPOSE 80 3000
CMD ["node", "dist/index.js"]
