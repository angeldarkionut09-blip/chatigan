FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV DATABASE_URL=file:./dev.db
COPY package.json package-lock.json ./
RUN npm ci --cache /tmp/npm-cache
COPY . .
RUN npm run build
RUN npm prune --omit=dev --cache /tmp/npm-cache

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/package.json ./package.json
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
