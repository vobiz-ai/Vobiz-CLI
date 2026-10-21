# syntax=docker/dockerfile:1
# Vobiz CLI in a container. Build: docker build -t vobiz-cli .
# Run with one-off credentials:
#   docker run --rm -e VOBIZ_AUTH_ID=MA_XXXXXXXX -e VOBIZ_AUTH_TOKEN=YOUR_AUTH_TOKEN ghcr.io/vobiz-ai/vobiz-cli whoami
# or with a saved login (read-only mount of your config directory):
#   docker run --rm -v ~/.config/vobiz:/home/node/.config/vobiz:ro ghcr.io/vobiz-ai/vobiz-cli numbers list
#
# Base image pinned by digest (multi-arch index of node:24-alpine, Node 24.22.1 / Alpine 3.24.2), so a rebuild is
# reproducible and a re-pushed tag cannot change what we ship. Dependabot (docker ecosystem) bumps the digest.
# Refresh by hand: docker buildx imagetools inspect node:24-alpine  (the top-level "Digest:"), in both stages.
FROM node:24-alpine@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: dependency lifecycle scripts never run; the build below is explicit.
RUN npm ci --ignore-scripts
COPY . .
# The optional directories (skills/, completions/, man/) may not exist yet; create them so the runtime COPY succeeds.
RUN npm run build && npm prune --omit=dev && mkdir -p skills completions man

FROM node:24-alpine@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d
ARG VERSION=dev
LABEL org.opencontainers.image.title="Vobiz CLI" \
      org.opencontainers.image.description="Official Vobiz CLI: voice calls, SMS, phone numbers, SIP trunks, VobizXML and call records from your terminal and CI" \
      org.opencontainers.image.source="https://github.com/vobiz-ai/Vobiz-CLI" \
      org.opencontainers.image.url="https://www.vobiz.ai/docs/resources/cli" \
      org.opencontainers.image.documentation="https://www.vobiz.ai/docs/resources/cli" \
      org.opencontainers.image.vendor="Vobiz" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"
# The runtime only needs `node`: npm, npx and corepack are removed to shrink the attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && mkdir -p /home/node/.config/vobiz && chown -R node:node /home/node/.config && chmod 700 /home/node/.config/vobiz
WORKDIR /app
# The daily npm version check makes no sense inside an immutable image: update by pulling a newer tag.
ENV NODE_ENV=production VOBIZ_NO_UPDATE_CHECK=1
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/spec ./spec
COPY --from=build /app/skills ./skills
COPY --from=build /app/completions ./completions
COPY --from=build /app/man ./man
COPY package.json LICENSE README.md ./
USER node
WORKDIR /home/node
ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["--help"]
