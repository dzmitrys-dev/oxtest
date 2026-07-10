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

# Install the two host tools the worker shells out to per scan (gap 05-04, CR-01/CR-02):
#   - git         : RepoClonerAdapter runs `git clone` (ENOENT without it).
#   - docker CLI  : TrivyRunnerAdapter (TRIVY_MODE=docker) runs the pinned Trivy
#                   image as a SIBLING container via the mounted socket (D-06).
#                   Client ONLY — no daemon/engine — so Trivy's memory stays in a
#                   separate container, never counting against the worker's 200m cap.
# This apt layer sits before the npm copy so it caches independently of app deps.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli \
 && apt-get purge -y --auto-remove curl gnupg \
 && rm -rf /var/lib/apt/lists/*

# Reinstall with production dependencies only, then drop the npm cache so it
# does not bloat the image layer (V12 — keep the surface small).
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev && npm cache clean --force

# Bring in ONLY the compiled output from the builder stage. Source, tests,
# planning docs and build tooling never enter the runtime image.
COPY --from=builder /app/apps/api/dist ./apps/api/dist

# Runtime entrypoint (gap 05-04): the container STARTS as root solely so the
# entrypoint can grant the `node` user the mounted docker.sock's (host-specific)
# group, then it drops to non-root `node` via setpriv before exec'ing the app.
# D-05 is preserved — the app process runs as `node`, never root. No `USER node`
# here because the entrypoint must adjust groups as root first, then de-escalate.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
