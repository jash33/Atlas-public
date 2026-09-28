FROM ghcr.io/voidzero-dev/vite-plus:0.2.6 AS build
WORKDIR /workspace
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=vp:vp apps/backend/package.json ./apps/backend/package.json
COPY --chown=vp:vp apps/console/package.json ./apps/console/package.json
COPY --chown=vp:vp apps/marketing-site/package.json ./apps/marketing-site/package.json
COPY --chown=vp:vp apps/mock-services/package.json ./apps/mock-services/package.json
COPY --chown=vp:vp apps/worker/package.json ./apps/worker/package.json
COPY --chown=vp:vp apps/ingest/package.json ./apps/ingest/package.json
COPY --chown=vp:vp apps/onboarding-site/package.json ./apps/onboarding-site/package.json
COPY --chown=vp:vp packages/demo-estate/package.json ./packages/demo-estate/package.json
COPY --chown=vp:vp packages/execution-grant/package.json ./packages/execution-grant/package.json
COPY --chown=vp:vp packages/runtime-ports/package.json ./packages/runtime-ports/package.json
COPY --chown=vp:vp packages/temporal-adapter/package.json ./packages/temporal-adapter/package.json
COPY --chown=vp:vp packages/test-support/package.json ./packages/test-support/package.json
COPY --chown=vp:vp packages/transformation-runtime/package.json ./packages/transformation-runtime/package.json
COPY --chown=vp:vp packages/workflow-artifact/package.json ./packages/workflow-artifact/package.json
COPY --chown=vp:vp packages/workflow-ir/package.json ./packages/workflow-ir/package.json
RUN vp install --frozen-lockfile
RUN tar -cf /tmp/workspace-node-modules.tar $(find apps packages -type d -name node_modules -prune)
COPY --chown=vp:vp . .
RUN tar -xf /tmp/workspace-node-modules.tar && rm /tmp/workspace-node-modules.tar
RUN vp run -t @atlas/worker#build

FROM node:24.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
COPY --from=build --chown=node:node /workspace/package.json ./package.json
COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/apps ./apps
COPY --from=build --chown=node:node /workspace/packages ./packages
USER node
CMD ["node", "apps/worker/dist/index.js"]
