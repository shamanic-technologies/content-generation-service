# Stage 1: Builder
FROM node:20-slim AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@9

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install dependencies
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source code
COPY . .

# Build TypeScript
RUN pnpm build

# Stage 2: Production
FROM node:20-slim

WORKDIR /app

# Install pnpm and ffmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@9

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod

# Chromium for the industry debrief video (src/lib/debrief/): captures public LinkedIn/X
# embeds and renders the scene frame by frame. Emoji + Latin fallback fonts so a post's
# emoji and symbols draw like they do in a browser, not as boxes.
RUN npx playwright install --with-deps chromium \
  && apt-get update && apt-get install -y fonts-noto-color-emoji fonts-liberation && rm -rf /var/lib/apt/lists/*

# Copy built files, migrations, and OpenAPI spec
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/openapi.json ./openapi.json
COPY --from=builder /app/assets ./assets

# Force IPv4 first to avoid IPv6 connection issues with Neon
ENV NODE_OPTIONS="--dns-result-order=ipv4first"

CMD ["node", "--import", "./dist/instrument.js", "dist/index.js"]
