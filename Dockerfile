FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production
# Keep /app/data on a persistent volume: it holds the database (and the Excel price list if you use one).
VOLUME /app/data
EXPOSE 3000
CMD ["npm", "start"]
