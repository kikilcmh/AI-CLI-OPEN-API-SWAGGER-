FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js ./

# agy binary dan ~/.gemini di-mount dari host, HOME harus match mount point
ENV HOME=/home/app-data

# node user (uid=1000) sudah ada di node:24-slim
USER node

EXPOSE 3986

CMD ["node", "index.js"]
