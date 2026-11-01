# NEXA web — Vite multi-page build → nginx static serve.
# Build context: monorepo root (needs pnpm workspace + shared-zod).

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/shared-zod/package.json packages/shared-zod/
COPY packages/realtime-client/package.json packages/realtime-client/
COPY packages/charts/package.json packages/charts/
RUN pnpm install --frozen-lockfile --filter @nexa/web... --filter @nexa/shared-zod... --filter @nexa/realtime-client... --filter @nexa/charts...
COPY packages/shared-zod packages/shared-zod
COPY packages/realtime-client packages/realtime-client
COPY packages/charts packages/charts
COPY apps/web apps/web
ARG VITE_NEXA_API_BASE
ARG VITE_MAZE_PAY_BASE_URL
ARG VITE_REALTIME_HUB_ENABLED
# Privy is the only door into the product — without these the bundle falls
# back to the e2e bridge button and production sign-in is dead. APP_ID is
# required; CLIENT_ID is optional in the React SDK.
ARG VITE_PRIVY_APP_ID
ARG VITE_PRIVY_CLIENT_ID
ENV VITE_NEXA_API_BASE=$VITE_NEXA_API_BASE
ENV VITE_MAZE_PAY_BASE_URL=$VITE_MAZE_PAY_BASE_URL
ENV VITE_REALTIME_HUB_ENABLED=$VITE_REALTIME_HUB_ENABLED
ENV VITE_PRIVY_APP_ID=$VITE_PRIVY_APP_ID
ENV VITE_PRIVY_CLIENT_ID=$VITE_PRIVY_CLIENT_ID
RUN pnpm --filter @nexa/web build

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --retries=6 \
  CMD wget -qO- http://127.0.0.1/healthz | grep -q '"ok":true' || exit 1
