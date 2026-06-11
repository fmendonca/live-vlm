FROM node:22-alpine

RUN apk add --no-cache ffmpeg

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    APP_VERSION=0.1.15

WORKDIR /opt/app-root/src

COPY package.json package.json
COPY server.js server.js
COPY storage.js storage.js
COPY VERSION VERSION
COPY public public

RUN chgrp -R 0 /opt/app-root/src && \
    chmod -R g=u /opt/app-root/src

USER 1001

EXPOSE 3000

CMD ["node", "server.js"]
