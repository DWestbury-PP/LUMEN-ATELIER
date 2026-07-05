FROM node:22-bookworm-slim

# Playwright's pinned Chromium instead of Debian's: apt upgraded chromium
# underneath us (149 -> 150) on a cache-cold rebuild and it stopped
# launching in the container. The Playwright version in package.json now
# decides the browser, deterministically, on amd64 and arm64 alike.
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-liberation dumb-init \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
RUN npx playwright install --with-deps --no-shell chromium \
  && rm -rf /var/lib/apt/lists/*
COPY server.js ./

EXPOSE 8282
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
