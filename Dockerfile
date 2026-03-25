FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY prisma/ ./
RUN npm ci
RUN npx prisma generate
COPY . .
RUN npm run build

FROM node:24-alpine
RUN apk add --no-cache git docker-cli docker-cli-compose
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/prisma ./prisma
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh
ENTRYPOINT ["sh", "entrypoint.sh"]