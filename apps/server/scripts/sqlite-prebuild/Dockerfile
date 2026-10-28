# 只为生成 better-sqlite3 的老 glibc 基线产物，见 apps/server/scripts/build-sqlite-prebuild.mjs。
#
# 基线锁 Debian 10（glibc 2.28、GCC 8）：Node 22 本体最低就要 glibc 2.28，所以按这个基线编出来的
# 产物在所有跑得动 Node 22 的 Linux 上都能加载（glibc / libstdc++ 向后兼容）。
# buster 已 EOL、官方源下线，因此源指向 archive.debian.org。
FROM debian:10

ARG NODE_VERSION=22.19.0
ARG NODE_ARCH=x64

RUN set -eux; \
    echo 'deb [trusted=yes] http://archive.debian.org/debian buster main' > /etc/apt/sources.list; \
    echo 'deb [trusted=yes] http://archive.debian.org/debian-security buster/updates main' >> /etc/apt/sources.list; \
    echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99no-check; \
    apt-get update -qq; \
    apt-get install -y -qq --no-install-recommends curl xz-utils ca-certificates python3 make g++ binutils; \
    rm -rf /var/lib/apt/lists/*; \
    curl -fsSL -o /tmp/node.tar.xz "https://cdn.npmmirror.com/binaries/node/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"; \
    tar xf /tmp/node.tar.xz -C /opt; \
    mv "/opt/node-v${NODE_VERSION}-linux-${NODE_ARCH}" /opt/node; \
    rm /tmp/node.tar.xz

ENV PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
