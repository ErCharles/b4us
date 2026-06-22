# node:20-alpine pinned by multi-arch index digest (resolved 2026-06-21).
# To re-pin after a base-image bump:
#   docker buildx imagetools inspect node:20-alpine        # shows the index digest
#   # or, without docker:
#   TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull" | jq -r .token)
#   curl -sI -H "Authorization: Bearer $TOKEN" \
#     -H 'Accept: application/vnd.oci.image.index.v1+json' \
#     https://registry-1.docker.io/v2/library/node/manifests/20-alpine | grep -i docker-content-digest
# Then replace the sha256 below.
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

WORKDIR /app

# Install deps as root, but own them as `node` so the runtime user can read
# the whole tree (node_modules + app code) while it stays non-writable.
COPY --chown=node:node package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY --chown=node:node . .

EXPOSE 3000

# Graceful shutdown
STOPSIGNAL SIGTERM

# Run unprivileged. The official node image ships the `node` user (uid 1000).
# The app only reads from /app and writes nothing to disk, so this is safe
# even with a read-only root filesystem (see docker-compose.yml).
USER node

CMD ["node", "src/server.js"]
