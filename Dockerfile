# Symphonix Log Lens — production image.
# Single Node process serves the API and the built frontend.
# NOTE: `git` is required at runtime — the app sparse-clones the connected
# Salesforce repo via the `git` CLI (see server/git-clone.ts).

FROM node:20-bookworm-slim

# git for repo cloning; ca-certificates for HTTPS clones. Clean apt cache.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build the frontend (vite -> dist/) and type-check.
COPY . .
RUN npm run build

ENV NODE_ENV=production
# App Runner sends traffic to this port; the server reads process.env.PORT.
ENV PORT=8080
EXPOSE 8080

# Drop to a non-root user for runtime.
RUN chown -R node:node /app
USER node

CMD ["npm", "start"]
