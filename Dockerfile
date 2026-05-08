FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY . .

EXPOSE 3000

# Graceful shutdown
STOPSIGNAL SIGTERM

CMD ["node", "src/server.js"]
