FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    nodejs \
    npm \
    incus-client \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./

RUN mkdir -p /app/backups /app/uploads

ENV PORT=3030
ENV INCUS_BACKUP_DIR=/app/backups
ENV INCUS_CONF=/incus-client
ENV INCUS_COMPLETED_JOB_TTL_MS=180000
ARG VERSION=development
ENV APP_VERSION=$VERSION

EXPOSE 3030

CMD ["node", "server.js"]

