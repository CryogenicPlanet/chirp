# Chirp sign-in issuer (auth.chirp.wiki). Build context is the repository root.
FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6
WORKDIR /opt/chirp
COPY package.json bun.lock ./
COPY patches ./patches
COPY packages/signin/package.json packages/signin/package.json
# Only this workspace's production dependencies: effect, @effect/platform-bun and jose.
RUN bun install --production --frozen-lockfile --ignore-scripts --filter @comms/signin
COPY packages/signin/src packages/signin/src
WORKDIR /opt/chirp/packages/signin
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
USER bun
EXPOSE 8080
CMD ["bun", "src/main.ts"]
