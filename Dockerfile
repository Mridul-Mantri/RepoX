# ============================================================================
#  RepoX backend — multi-stage build
# ============================================================================

# ---- Stage 1: install deps + build TS -----------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Install OpenSSL (Prisma needs it on alpine) and build tools
RUN apk add --no-cache openssl libc6-compat

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig*.json nest-cli.json ./
COPY src ./src

RUN npx prisma generate
RUN npm run build

# Drop dev deps from node_modules for the runtime image
RUN npm prune --omit=dev


# ---- Stage 2: runtime ----------------------------------------------------
FROM node:20-alpine AS runtime

WORKDIR /app

RUN apk add --no-cache openssl libc6-compat tini && \
    addgroup -S repox && adduser -S repox -G repox

ENV NODE_ENV=production
ENV PORT=5000

COPY --from=builder --chown=repox:repox /app/node_modules ./node_modules
COPY --from=builder --chown=repox:repox /app/dist ./dist
COPY --from=builder --chown=repox:repox /app/prisma ./prisma
COPY --from=builder --chown=repox:repox /app/package*.json ./

USER repox

EXPOSE 5000

# tini = proper PID 1, forwards signals to Node so graceful shutdown works
ENTRYPOINT ["/sbin/tini", "--"]

# Run migrations on container start, then start the app. In production you
# generally want migrations to run as a one-off step in your CI/CD pipeline
# instead — this is convenient for dev/staging.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
