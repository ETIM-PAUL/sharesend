FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY agent ./agent
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
