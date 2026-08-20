# Valheim Codex — container image.
#
# Containerised rather than serverless because the app carries its own embedding
# model: the transformers runtime plus the model is ~580 MB, past every function
# size limit. It is also the better arrangement — a local embedding costs nothing
# per query and returns in 14 ms, against ~300 ms for an embeddings API.
#
# Deliberately NOT using `output: standalone`. Both ways of slimming the image
# were tried and both broke the model:
#
#   - standalone tracing is platform-specific and copies only the build host's
#     native binaries, and it emits absolute symlinks under pnpm;
#   - `node-linker=hoisted` flattens a tree that legitimately holds several
#     versions and per-platform variants, which resolved onnxruntime to a build
#     incompatible with Node 24 and left sharp unable to dlopen.
#
# Shipping the production dependency tree exactly as the package manager built
# it is larger and correct. Correct wins.

# ---- deps: everything, because the build needs devDependencies --------------
FROM node:22-slim AS deps
WORKDIR /app
# `corepack enable` alone installs whatever pnpm is newest, which is not the
# one that produced the lockfile. package.json pins it, and this makes corepack
# fetch that exact version before the install runs.
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN corepack prepare --activate && pnpm install --frozen-lockfile

# ---- builder ----------------------------------------------------------------
FROM node:22-slim AS builder
WORKDIR /app
RUN corepack enable

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV EMBEDDING_PROVIDER=local
# A path the image owns, rather than one that carries the package version.
ENV MODEL_CACHE_DIR=/app/.model-cache

RUN pnpm build

# Download the model into the image. Without this the container fetches 283 MB
# on its first question, and again after every restart.
RUN pnpm prefetch:model

# ---- prod deps: the same tree without the build-only packages ---------------
FROM node:22-slim AS proddeps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN corepack prepare --activate && pnpm install --frozen-lockfile --prod

# ---- runner -----------------------------------------------------------------
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV EMBEDDING_PROVIDER=local
ENV MODEL_CACHE_DIR=/app/.model-cache
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN corepack enable \
 && groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=proddeps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder  --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder  --chown=nextjs:nodejs /app/public ./public
COPY --from=builder  --chown=nextjs:nodejs /app/package.json ./package.json

# Migrations travel with the image so a deploy can apply them if needed.
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle

# The model cache is not a dependency and is not installed by the prod install;
# it comes from the builder, where prefetch put it.
COPY --from=builder --chown=nextjs:nodejs \
  /app/node_modules/.pnpm/@huggingface+transformers@4.2.0/node_modules/@huggingface/transformers/.cache \
  ./node_modules/.pnpm/@huggingface+transformers@4.2.0/node_modules/@huggingface/transformers/.cache

# Proves the model loads from this exact file set, on this exact platform,
# before the image is considered good. A build failure here is far cheaper than
# a container that starts cleanly and fails on the first question.
COPY --from=builder --chown=nextjs:nodejs /app/scripts/verify-standalone.mjs ./verify.mjs
RUN node verify.mjs && rm verify.mjs

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "start"]
