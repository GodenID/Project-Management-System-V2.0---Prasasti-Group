FROM node:22-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY server/package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server/ ./

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "index.js"]
