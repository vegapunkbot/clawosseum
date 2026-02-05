FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.mjs ./
ENV PORT=5195
# Optional: set to lock down POST endpoints (agents-only)
# ENV ARENA_AGENT_TOKEN=change-me
EXPOSE 5195
CMD ["npm","start"]
