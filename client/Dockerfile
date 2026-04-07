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
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD curl -sf http://localhost/ -o /dev/null || exit 1
CMD ["nginx", "-g", "daemon off;"]
