FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
COPY watcher.js ./

USER node

CMD ["node", "watcher.js"]
