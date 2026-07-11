# The rootfs for the browser bash sandbox (see build-image.mjs).
# Must stay riscv64-installable: every package here needs a riscv64 build in
# Alpine main/community, and native npm deps need a linux-riscv64 binary.
#
# py3-numpy + py3-pandas back the data-analysis app (apps/client): the agent
# does real computation on the user's CSV in here. Both have riscv64 builds in
# Alpine 3.20 community. (No matplotlib — charts are interactive JS in the
# generated dashboard, not server-rendered images.) If pandas is ever
# unavailable the agent falls back to Python's stdlib `csv` module.
FROM alpine:3.20
RUN apk add --no-cache python3 nodejs npm py3-numpy py3-pandas \
 && npm install -g typescript tsx \
 && npm cache clean --force
