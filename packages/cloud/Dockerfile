# Chirp Cloud control plane. Build context is the repository root.
FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS install
WORKDIR /opt/chirp
COPY package.json bun.lock ./
COPY patches ./patches
COPY packages/boot/package.json packages/boot/package.json
COPY packages/cloud/package.json packages/cloud/package.json
COPY packages/landing/package.json packages/landing/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/ui/package.json packages/ui/package.json

FROM install AS build
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.base.json tsconfig.json ./
COPY packages/cloud packages/cloud
WORKDIR /opt/chirp/packages/cloud
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

FROM install AS dependencies
RUN bun install --production --frozen-lockfile --ignore-scripts

FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS runtime
WORKDIR /opt/chirp
COPY --from=dependencies /opt/chirp /opt/chirp
COPY tsconfig.base.json tsconfig.json ./
COPY packages/cloud/src packages/cloud/src
COPY packages/cloud/public packages/cloud/public
COPY packages/cloud/next.config.ts packages/cloud/next.config.ts
COPY --from=build /opt/chirp/packages/cloud/.next packages/cloud/.next
WORKDIR /opt/chirp/packages/cloud
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 NEXT_TELEMETRY_DISABLED=1
EXPOSE 8080
CMD ["bun", "src/server.ts"]
