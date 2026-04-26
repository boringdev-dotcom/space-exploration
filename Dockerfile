FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .

RUN npm run build

# --- Production stage ---
FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY <<'EOF' /etc/nginx/conf.d/default.conf
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(?:css|js|svg|png|jpg|jpeg|gif|ico|woff2?|wasm|spz)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
EOF

EXPOSE 80
# Render injects PORT for Docker web services; default 80 for local runs.
CMD sh -c 'sed -i "s/listen 80;/listen ${PORT:-80};/" /etc/nginx/conf.d/default.conf && exec nginx -g "daemon off;"'
