#!/bin/sh
# docker-entrypoint.sh — gap 05-04 (OPS-02).
#
# The worker reaches the pinned Trivy scanner as a SIBLING container through the
# mounted /var/run/docker.sock (D-06), and clones repos with `git`. To honor D-05
# (the app process runs as the unprivileged `node` user) WHILE letting that user
# reach a socket whose group id is the HOST's docker gid — which varies per host
# and is unknown at build time — this entrypoint resolves the socket's gid at
# runtime, grants `node` membership, then drops privileges before exec'ing the
# app. This is what makes a raw `docker compose up` work end-to-end on any host
# without the reviewer having to discover and pass their docker gid.
#
# The container therefore STARTS as root (to adjust the group) but the app itself
# NEVER runs as root — `setpriv` re-executes it as `node` with correct groups.
set -e

SOCK=/var/run/docker.sock
if [ -S "$SOCK" ]; then
  SOCK_GID=$(stat -c '%g' "$SOCK" 2>/dev/null || echo "")
  if [ -n "$SOCK_GID" ] && [ "$SOCK_GID" != "0" ]; then
    if ! getent group "$SOCK_GID" >/dev/null 2>&1; then
      groupadd -g "$SOCK_GID" dockerhost >/dev/null 2>&1 || true
    fi
    GNAME=$(getent group "$SOCK_GID" | cut -d: -f1)
    [ -n "$GNAME" ] && usermod -aG "$GNAME" node >/dev/null 2>&1 || true
  fi
fi

# Drop to the unprivileged `node` user with freshly-initialized supplementary
# groups (now including the socket group). exec replaces this shell, so no extra
# process/RSS lingers under the worker's 200m cap.
exec setpriv --reuid node --regid node --init-groups "$@"
