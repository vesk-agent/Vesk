# Vesk agent, built from this repo. For 24/7 use with docker compose (see docker-compose.yml).
#   docker compose up -d        start
#   docker compose logs -f      watch it
# Your keystore, config and state live in the ./vesk volume, never in the image.

FROM node:22.11.0-bookworm-slim AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --no-frozen-lockfile && pnpm build \
 && pnpm --filter vesk-agent deploy --prod /out

FROM node:22.11.0-bookworm-slim
ENV NODE_ENV=production VESK_HOME=/data
RUN mkdir -p /data && chown node:node /data
COPY --from=build /out /opt/vesk
RUN ln -s /opt/vesk/dist/index.js /usr/local/bin/vesk && chmod +x /opt/vesk/dist/index.js
USER node
VOLUME ["/data"]
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s CMD ["vesk", "status", "--json"]
ENTRYPOINT ["vesk"]
CMD ["summon", "--stream"]
