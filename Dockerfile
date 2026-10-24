FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 TRUST_PROXY=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY shared ./shared
COPY server ./server
COPY public ./public
EXPOSE 3000
USER node
CMD ["node", "server/index.js"]
