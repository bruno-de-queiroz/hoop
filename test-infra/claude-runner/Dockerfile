FROM node:22-alpine

# Hooks are bash scripts that parse JSON with jq.
RUN apk add --no-cache git jq bash

RUN npm install -g @anthropic-ai/claude-code

# Bake the hoop installer into the image.  The installer creates symlinks from
# /root/.claude/plugins/hoop/{skills,hooks,dist,...} into /build/..., which is
# bind-mounted at runtime.  Symlinks resolve lazily, so unmounted paths at
# image-build time are fine.
COPY scripts/install-hoop.sh /usr/local/bin/install-hoop
RUN chmod +x /usr/local/bin/install-hoop
ENV HOOP_SRC=/build HOOP_DEST=/root/.claude/plugins/hoop HOOP_INSTALL_MODE=symlink
RUN install-hoop

WORKDIR /repo
