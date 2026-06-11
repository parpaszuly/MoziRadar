FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY web ./web
RUN mkdir -p store

EXPOSE 3421
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3421
ENV DB_PATH=/app/store/moziradar.db

CMD ["node", "dist/index.js"]
