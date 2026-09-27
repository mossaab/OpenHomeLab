# ---- Stage 1: Install dependencies ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN apk add --no-cache python3 make g++ \
 && npm install --omit=dev \
 && apk del python3 make g++ \
 && npm cache clean --force

# ---- Stage 2: Build ----
FROM node:22-alpine AS build
WORKDIR /app
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}
COPY package.json package-lock.json ./
RUN apk add --no-cache python3 make g++ \
 && npm install \
 && apk del python3 make g++ \
 && npm cache clean --force
COPY . .
RUN npm run build

# ---- Stage 3: Production ----
FROM node:22-alpine AS production
WORKDIR /app

RUN apk add --no-cache iputils

# Copy production dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy built assets
COPY --from=build /app/dist ./dist

# Copy OUI vendor database (MAC prefix -> manufacturer)
COPY --from=build /app/server-data ./server-data

# Copy server entry (already built as dist/server.cjs)
COPY --from=build /app/dist/server.cjs ./dist/server.cjs
COPY --from=build /app/dist/server.cjs.map ./dist/server.cjs.map

# Copy package.json (for metadata only)
COPY package.json ./

# Expose the port the app runs on
EXPOSE 3000

# Set production environment
ENV NODE_ENV=production

# Use PORT env var (default 3000 internally)
ENV PORT=3000

# Prepare persistent data directory owned by the non-root user
RUN mkdir -p /app/data && chown -R node:node /app/data

# Volume for SQLite persistence
VOLUME /app/data

# Run as non-root user
USER node

# Run the server
CMD ["node", "dist/server.cjs"]
