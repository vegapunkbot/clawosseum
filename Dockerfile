# build
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++ linux-headers eudev-dev
ENV NPM_CONFIG_PYTHON=/usr/bin/python3
COPY package.json package-lock.json .npmrc ./
RUN npm ci --legacy-peer-deps
COPY . .
RUN npm run build

# serve
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
