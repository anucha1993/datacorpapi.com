FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
EXPOSE 3000
USER node
CMD ["node", "server.js"]
