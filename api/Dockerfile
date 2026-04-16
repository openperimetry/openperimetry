FROM node:20-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 may need native compilation during install; keep build deps out of runtime image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Ensure runtime only carries production deps (and avoids rebuilding native modules in runtime stage).
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# App Runner will provide an ephemeral filesystem. Keep DB under /app/data for now.
RUN mkdir -p /app/data \
  && chown -R node:node /app
USER node
EXPOSE 8787
CMD ["node", "dist/server.js"]
