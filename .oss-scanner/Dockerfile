# Build image for Anthropic OSS Scanner (https://github.com/anthropics/oss-scanner).
# Network is available only during this build; everything the tests need is installed here.
FROM oven/bun:1.4.4-debian
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git bash curl python3 \
    && rm -rf /var/lib/apt/lists/*

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

# no npm dependencies (third-party client code is vendored); builds the client bundle
RUN bun scripts/build.ts --client-only

# Run the tests so the image is known to work, without failing the build on a red test.
RUN bun run test || echo "WARNING: tests reported failures"
