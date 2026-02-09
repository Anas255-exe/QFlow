FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY tsconfig.json ./
COPY public ./public

# Install esbuild for build step
RUN npm i -D esbuild

# Build
RUN npx esbuild src/qaAgent.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/qaAgent.mjs && \
    npx esbuild src/server.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/server.mjs

EXPOSE 3100

CMD ["node", "dist/server.mjs"]
