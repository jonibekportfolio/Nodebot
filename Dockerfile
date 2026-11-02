FROM node:20-alpine

# Tizim paketlari va xavfsizlik
RUN apk add --no-cache ca-certificates dumb-init

WORKDIR /app

# Kutubxonalarni o'rnatish
COPY package*.json ./
RUN npm ci --only=production

# Loyiha kodlarini ko'chirish
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "server.js"]
