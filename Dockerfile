FROM node:20-slim

# Install system ffmpeg (includes drawtext/libfreetype) + yt-dlp + fonts
RUN apt-get update && apt-get install -y \
    curl ca-certificates ffmpeg fonts-dejavu-core \
    --no-install-recommends && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
      -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
