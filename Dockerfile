# syntax=docker/dockerfile:1
#
# Code Guardian — multi-stage build (D-05, RESEARCH Pattern 3).
#
# Base image: node:22-slim (Debian slim) — NOT alpine (musl can inflate RSS,
# which is graded here) and NOT distroless (no shell — the worker needs one for
# the scanner Docker fallback shell-out, D-06). Matches the pinned Node 22
# runtime (engines ">=22 <23", .nvmrc=22).
#
# No CMD is set: the api and worker services each set their own command in
# docker-compose.yml (api = dist/index.js verbatim self-test entrypoint;
# worker = node --max-old-space-size=150 dist/worker.js). The security scanner
# is deliberately NOT installed here — the worker reaches the pinned ghcr
# scanner image as a sibling container via the mounted Docker socket (D-06).

# ---- builder ----
# Full dependency install + compile. This stage carries devDependencies
# (@nestjs/cli, typescript, tsx) and is discarded from the final image.
FROM node:22-slim AS builder
WORKDIR /app

# Copy only the manifests first so `npm ci` is cached until deps change.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci

# Copy the rest of the workspace and produce the compiled output at
# apps/api/dist/ (nest build → dist/index.js + dist/worker.js; the trailing tsc
# pass emits dist/scripts/*.js).
COPY . .
RUN npm run build --workspace apps/api

# ---- runtime ----
# Lean production image: prod-only deps, compiled dist, non-root user.
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Reinstall with production dependencies only, then drop the npm cache so it
# does not bloat the image layer (V12 — keep the surface small).
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev && npm cache clean --force

# Bring in ONLY the compiled output from the builder stage. Source, tests,
# planning docs and build tooling never enter the runtime image.
COPY --from=builder /app/apps/api/dist ./apps/api/dist

# Run as the unprivileged `node` user baked into the official image (D-05).
USER node
