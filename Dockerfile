FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

ENV DATA_DIR=/data
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node

EXPOSE 3000
CMD ["node", "src/index.ts"]
