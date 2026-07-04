FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --include=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src

EXPOSE 8181
CMD ["npx", "tsx", "src/index.ts"]
