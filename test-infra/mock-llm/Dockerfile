FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY scenarios/ ./scenarios/
EXPOSE 4000
CMD ["node", "server.js"]
