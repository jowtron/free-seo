# Stage 1: Install dependencies and build the client
FROM node:22-slim AS build

WORKDIR /app

# Copy package files for workspace setup
COPY package.json ./
COPY client/package.json client/
COPY server/package.json server/

# Install all dependencies (including devDependencies for building)
RUN npm install

# Copy source code
COPY shared/ shared/
COPY client/ client/
COPY server/ server/

# Build the client
RUN npm run build -w client

# Stage 2: Production image
FROM node:22-slim AS production

# Install Playwright system dependencies (Chromium)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    libwayland-client0 \
    fonts-noto-color-emoji \
    fonts-freefont-ttf \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json ./
COPY server/package.json server/

# Install production dependencies for the server workspace (tsx is included as a dependency)
RUN npm install -w server --omit=dev --ignore-scripts

# Install Playwright Chromium browser into a world-readable location, so the
# unprivileged runtime user (USER below) can execute it. The default lands in
# /root/.cache, which uid 1000 cannot read.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx -w server playwright install chromium \
    && chmod -R a+rX /ms-playwright

# Copy server source and shared types
COPY shared/ shared/
COPY server/ server/

# Copy built client from build stage
COPY --from=build /app/client/dist client/dist

# Create data directory for audit counter persistence
RUN mkdir -p server/data && chown -R node:node /app

# Default environment variables
ENV NODE_ENV=production
ENV PORT=80

EXPOSE 80

# This app renders arbitrary attacker-supplied pages in a real browser. Do NOT
# run that as root. node:22-slim already ships uid 1000 `node`.
USER node

CMD ["npm", "start"]
