FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY tsconfig.json ./
COPY public ./public

# Install esbuild for build step
RUN npm i -D esbuild typescript

# Build
RUN npx esbuild src/qaAgent.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/qaAgent.mjs && \
    npx esbuild src/server.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/server.mjs

# Clean up dev deps after build
RUN npm prune --omit=dev

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:3100/api/health || exit 1

CMD ["node", "dist/server.mjs"]
