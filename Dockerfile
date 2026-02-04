# build
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++ linux-headers
ENV NPM_CONFIG_PYTHON=/usr/bin/python3
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# serve
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
