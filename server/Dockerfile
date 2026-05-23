# BUG 3 FIX: Previous CMD ran "npm run dev" (nodemon) which is a devDependency.
# Render runs npm ci --omit=dev by default, so nodemon is not installed.
# The container would crash immediately with "nodemon: not found".
#
# Fixes applied:
#   1. Use node:20-alpine (smaller, faster image)
#   2. npm ci --omit=dev (only production dependencies)
#   3. CMD ["node", "index.js"] — direct Node, no dev tools

FROM node:20-alpine

# Install postgresql-client for optional migration scripts
RUN apk add --no-cache postgresql-client

WORKDIR /app

# Copy package files first for layer caching
COPY package*.json ./

# Install ONLY production dependencies
# (nodemon, vitest, etc. are devDependencies and intentionally excluded)
RUN npm ci --omit=dev

# Copy source code
COPY . .

EXPOSE 5000

# Health check — Render uses this to determine when the service is ready
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -q --spider http://localhost:5000/health || exit 1

# Run the server directly — no nodemon, no dev watcher
CMD ["node", "index.js"]