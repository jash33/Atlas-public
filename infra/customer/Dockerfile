FROM ghcr.io/voidzero-dev/vite-plus:0.2.6 AS build
WORKDIR /workspace
COPY --chown=vp:vp . .
RUN vp install --frozen-lockfile
RUN vp exec tsc -b packages/demo-estate packages/temporal-adapter apps/backend
# Every installation uses these same static files; provider settings come from the backend.
RUN cd apps/console && VITE_ATLAS_AUTH_MODE=customer vp build

FROM node:24.19.0-bookworm-slim AS backend
ENV NODE_ENV=production
WORKDIR /workspace
COPY --from=build --chown=node:node /workspace/package.json ./package.json
COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/apps ./apps
COPY --from=build --chown=node:node /workspace/packages ./packages
USER node
CMD ["node", "apps/backend/dist/index.js"]

FROM caddy:2.10.2-alpine AS console
COPY --from=build /workspace/apps/console/dist /srv
COPY infra/customer/Caddyfile /etc/caddy/Caddyfile
