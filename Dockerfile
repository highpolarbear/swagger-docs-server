# ---- Stage 1: fetch the openapi-generator jar ---------------------------------
# The official jar, as published to PyPI by the OpenAPI Generator team. The download is
# verified against its SHA-256, so a tampered or corrupted file fails the build.
FROM node:22-alpine AS generator
ARG GENERATOR_WHEEL_URL=https://files.pythonhosted.org/packages/b6/fd/36deca16b2312ef5e3d5ee77ed1b1e3550c98dee60fffc76e16e25697149/openapi_generator_cli-7.26.0-py3-none-any.whl
ARG GENERATOR_WHEEL_SHA256=e6305fbbf91aa41b3b7fcd8bf2124880ab0bb9e32efad95b3dfe71f9313d856c
WORKDIR /tmp/gen
RUN wget -q -O generator.whl "$GENERATOR_WHEEL_URL" \
 && echo "$GENERATOR_WHEEL_SHA256  generator.whl" | sha256sum -c - \
 && unzip -q generator.whl "openapi_generator_cli/openapi-generator.jar" \
 && test -s openapi_generator_cli/openapi-generator.jar

# ---- Stage 2: the docs server -------------------------------------------------
FROM node:22-alpine

# Java runtime for stub generation
RUN apk add --no-cache openjdk21-jre-headless
ENV PATH="/usr/lib/jvm/default-jvm/bin:${PATH}"

WORKDIR /app
ENV NODE_ENV=production

# Install dependencies first so they're cached between builds
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=generator /tmp/gen/openapi_generator_cli/openapi-generator.jar /opt/openapi-generator/openapi-generator.jar
# Fail the build now if Java or the jar doesn't work, rather than on the first download
RUN java -jar /opt/openapi-generator/openapi-generator.jar version

COPY src ./src
COPY public ./public
COPY starter ./starter

# The spec lives in /data so it survives container rebuilds
RUN mkdir -p /data && chown node:node /data
USER node

ENV PORT=8080 \
    SPEC_PATH=/data/openapi.yaml \
    GENERATOR_JAR=/opt/openapi-generator/openapi-generator.jar \
    GENERATOR_VERSION=7.26.0

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "src/server.js"]
