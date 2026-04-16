# web/Dockerfile — production-style static build for the OpenPerimetry frontend.
#
# Stage 1 builds the Vite bundle; stage 2 serves the dist with a small
# nginx. For pure local dev you probably want to run `npm run dev`
# directly on the host; this Dockerfile is here so `docker compose up`
# produces a static build and the web service behaves like a real
# deployment.

FROM node:22-alpine AS build

WORKDIR /app

# Install deps first so they cache across source changes.
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source and build.
COPY tsconfig*.json vite.config.ts eslint.config.js index.html ./
COPY public ./public
COPY src ./src

# Build-time branding / API URL. Override in docker-compose (or CI) via
# --build-arg to rebrand a fork; defaults resolve to OpenPerimetry at
# localhost.
ARG VITE_API_URL=http://localhost:8787
ARG VITE_APP_NAME=OpenPerimetry
ARG VITE_APP_URL=http://localhost:5173
ENV VITE_API_URL=$VITE_API_URL \
    VITE_APP_NAME=$VITE_APP_NAME \
    VITE_APP_URL=$VITE_APP_URL

RUN npm run build

# ── Stage 2: serve with nginx ─────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

COPY --from=build /app/dist /usr/share/nginx/html

# SPA fallback — every unmatched route serves index.html so client
# routing works.
RUN printf '%s\n' \
  'server {' \
  '  listen 80;' \
  '  root /usr/share/nginx/html;' \
  '  index index.html;' \
  '  location / {' \
  '    try_files $uri $uri/ /index.html;' \
  '  }' \
  '}' > /etc/nginx/conf.d/default.conf

EXPOSE 80
