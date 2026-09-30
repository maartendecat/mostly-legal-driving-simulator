# One container runs everything: the game server, which also serves the built game page.
FROM node:24-alpine
WORKDIR /app

# Install dependencies first, so they're cached while only the code changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/
COPY packages/server/package.json packages/server/
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production PORT=8080
EXPOSE 8080
# Hosts may set their own PORT; the check follows it.
HEALTHCHECK CMD wget -qO- "http://localhost:${PORT:-8080}/healthz" || exit 1
CMD ["npm", "start", "-w", "@game/server"]
