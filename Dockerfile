FROM node:24-slim
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --chown=node:node package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","src/server.mjs"]
