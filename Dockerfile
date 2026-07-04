# Railway deployment image: the studio orchestrator serving the built gallery.
# (Local development uses docker-compose with separate web/studio containers;
# this single container keeps the Railway topology simple: app + renderer + db.)

FROM node:22-bookworm-slim AS webbuild
WORKDIR /web
COPY web/package.json ./
RUN npm install
COPY web/tsconfig.json web/tsconfig.node.json web/vite.config.ts web/index.html ./
COPY web/public ./public
COPY web/src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY studio/package.json ./
RUN npm install --include=dev && npm cache clean --force
COPY studio/tsconfig.json ./
COPY studio/src ./src
COPY --from=webbuild /web/dist ./public
ENV STATIC_DIR=/app/public
EXPOSE 8181
CMD ["npx", "tsx", "src/index.ts"]
