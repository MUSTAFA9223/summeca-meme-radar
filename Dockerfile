FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY .env.example ./.env.example
CMD ["node", "src/bootstrap.mjs"]
