FROM node:22 AS builder

WORKDIR /app
RUN mkdir -p scripts
COPY package-lock.json package.json ./
COPY scripts/patch-hono-node-server.cjs ./scripts/
RUN npm ci
COPY . .
RUN npm run build

# Build the final image
RUN rm -rf node_modules
RUN npm ci --omit=dev

FROM gcr.io/distroless/nodejs22-debian12 AS runner
WORKDIR /app
COPY ./pages/ ./pages/
COPY ./favicon.ico .
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/c /app/c
CMD ["/app/c/index.js"]
