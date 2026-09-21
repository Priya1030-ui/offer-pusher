FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY server.mjs ./
COPY offers.tsv ./
COPY web ./web

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

CMD ["node", "server.mjs"]
