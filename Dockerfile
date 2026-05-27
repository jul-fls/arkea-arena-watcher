FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV STATE_FILE=/data/state.json
ENV SESSION_FILE=/data/session.json

COPY package.json ./
COPY watcher.js ./

USER root
RUN mkdir -p /data && chown -R node:node /data

USER node

CMD ["node", "watcher.js"]
