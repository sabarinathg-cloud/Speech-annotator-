FROM node:22-alpine AS deps
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /workspace/apps/frontend
COPY apps/frontend/package.json apps/frontend/package-lock.json* ./
COPY packages/shared-types /workspace/packages/shared-types
RUN npm ci --no-audit --no-fund

FROM node:22-alpine AS builder
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
WORKDIR /workspace/apps/frontend
COPY --from=deps /workspace/apps/frontend/node_modules ./node_modules
COPY apps/frontend ./
COPY packages/shared-types /workspace/packages/shared-types
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
COPY --from=builder /workspace/apps/frontend/.next/standalone ./
COPY --from=builder /workspace/apps/frontend/.next/static ./apps/frontend/.next/static
COPY --from=builder /workspace/apps/frontend/public ./apps/frontend/public
WORKDIR /app/apps/frontend
EXPOSE 3000
CMD ["node", "server.js"]
