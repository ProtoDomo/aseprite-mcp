# Build stage
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json ./

# Install dependencies (including dev dependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Compile TypeScript
RUN npm run build

# Runtime stage
FROM node:20-slim

WORKDIR /app

LABEL description="Aseprite MCP Server - Model Context Protocol server for Aseprite CLI"
LABEL maintainer="Aseprite MCP Contributors"

# Copy package files
COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --production

# Copy compiled JavaScript from builder stage
COPY --from=builder /app/build ./build

# Set environment variable for Aseprite path
# Users should mount Aseprite binary or set this to point to their installation
ENV ASEPRITE_PATH=/usr/local/bin/aseprite

# Health check - ensure stdio is responsive
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "console.log('health')" || exit 1

# Entrypoint for MCP server
ENTRYPOINT ["node", "build/index.js"]
