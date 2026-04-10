FROM node:20-alpine AS base

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts 2>/dev/null || npm install --omit=dev --ignore-scripts

# Copy source
COPY src/ ./src/

# Non-root user
RUN addgroup -g 1001 sentinel && \
    adduser -u 1001 -G sentinel -s /bin/sh -D sentinel
USER sentinel

EXPOSE 3900

ENV NODE_ENV=production
ENV PORT=3900

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3900/health || exit 1

CMD ["node", "src/server/index.js"]
