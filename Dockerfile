FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production
# Mount a persistent volume at /app/data (in your host's settings, not here: some hosts, like Railway, refuse
# a VOLUME line). It holds the database and the Excel price list.
EXPOSE 3000
CMD ["npm", "start"]
