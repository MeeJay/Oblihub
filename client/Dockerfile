FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json ./
COPY shared/ ./shared/
COPY client/package.json ./client/
RUN npm install --workspace=client

COPY client/ ./client/
RUN cd client && npm run build

FROM nginx:alpine AS production
RUN apk add --no-cache curl
COPY --from=builder /app/client/dist/ /usr/share/nginx/html/
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

# Health check verifies BOTH nginx AND backend connectivity.
# If the backend is unreachable (e.g. after server self-update with new IP),
# the health check fails → Docker restarts the client → nginx re-resolves DNS.
HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=15s \
    CMD curl -sf http://localhost/ -o /dev/null && curl -sf http://server:3001/health -o /dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
