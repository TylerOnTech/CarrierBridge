# syntax=docker/dockerfile:1.7
#
# One image runs every role (api, worker, mock carriers, migrations). The base is the
# official Playwright image pinned to the same version as package.json, so Chromium and
# its OS libraries always match the Playwright library that drives them.
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.63.0-noble

FROM ${PLAYWRIGHT_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY mock-carriers ./mock-carriers
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM ${PLAYWRIGHT_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=pwuser:pwuser /app/package.json ./
COPY --from=build --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --from=build --chown=pwuser:pwuser /app/dist ./dist
COPY --from=build --chown=pwuser:pwuser /app/prisma ./prisma
USER pwuser
EXPOSE 3000
CMD ["node", "dist/src/main.js"]
