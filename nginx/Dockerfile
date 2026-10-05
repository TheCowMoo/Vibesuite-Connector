FROM nginx:1.27-alpine
RUN apk add --no-cache certbot certbot-nginx
COPY conf.d/default.conf /etc/nginx/conf.d/default.conf
