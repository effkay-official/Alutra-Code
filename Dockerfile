# Build stage: install all deps and build the client bundle
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/package-lock.json ./server/
COPY client/package.json client/package-lock.json ./client/
COPY shared/package.json ./shared/

RUN npm ci --ignore-scripts && npm ci --prefix server --ignore-scripts && npm ci --prefix client

COPY . .
RUN npm run build --prefix client

# Runtime stage: only production deps + built client + server
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/client/dist ./client/dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json

EXPOSE 8787
CMD ["node", "server/src/index.js"]