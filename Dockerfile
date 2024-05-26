FROM node:latest as builder

WORKDIR /app
COPY package-lock.json package.json ./
RUN npm install
COPY . .
RUN npm run build


FROM debian:12-slim as runner
RUN mkdir -p /app
WORKDIR /app
RUN adduser app
#COPY --chown=app:app ./pages/ .
#COPY --chown=app:app ./favicon.ico .
COPY --chown=app:app . .
RUN npm install --omit=dev
COPY --from=builder --chown=app:app /app/c /app/c
