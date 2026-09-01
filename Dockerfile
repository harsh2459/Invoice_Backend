# Backend: long-running Express + Socket.IO + WhatsApp (Baileys). Runs from
# TypeScript source via tsx — no compile step.
FROM node:22-slim

# Baileys / pdfkit have no native build needs on slim, but keep certs fresh.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Persistent data (WhatsApp auth + media) lives here — mount a volume at /data.
ENV DATA_DIR=/data
RUN mkdir -p /data

EXPOSE 8090
CMD ["npm", "start"]
