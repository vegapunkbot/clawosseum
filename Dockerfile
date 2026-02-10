# build
FROM node:22-alpine AS build
WORKDIR /app

# Build-time env for Vite (Railway env vars are not always available during Docker builds)
ARG VITE_PRIVY_APP_ID
ENV VITE_PRIVY_APP_ID=${VITE_PRIVY_APP_ID}
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
