# Whole-site scan service for free-seo. Runs Unlighthouse (Lighthouse in
# Chromium, one page at a time) and a small link crawler. Meant to run behind an
# egress fence that allows the public internet only; see README.md.
FROM node:22-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
	CHROME_PATH=/usr/bin/chromium \
	SITE_SCAN_DATA=/data \
	PORT=8096

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src

RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8096
CMD ["node", "src/server.mjs"]
