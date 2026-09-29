FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY assets ./assets
ENV DATA_DIR=/app/data
VOLUME ["/app/data"]
ENV PORT=3001
EXPOSE 3001
CMD ["node", "dist/index.js"]
