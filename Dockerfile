FROM node:latest AS builder

WORKDIR /app
COPY package-lock.json package.json ./
RUN npm ci
COPY . .
RUN npm run build || true

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
