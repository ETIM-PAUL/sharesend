FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
# Binance Agentic Wallet CLI, for buys and the session keepalive (AUTO_EXECUTE=true).
# Its session lives in /root/.baw: mount a persistent volume there so a redeploy doesn't sign it out.
RUN npm install -g @binance/agentic-wallet@1.10.0 --no-audit --no-fund
COPY tsconfig.json ./
COPY agent ./agent
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
