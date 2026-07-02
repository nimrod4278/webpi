# The rootfs for the browser bash sandbox (see build-image.mjs).
# Must stay riscv64-installable: every package here needs a riscv64 build in
# Alpine main/community, and native npm deps need a linux-riscv64 binary.
FROM alpine:3.20
RUN apk add --no-cache python3 nodejs npm \
 && npm install -g typescript tsx \
 && npm cache clean --force
