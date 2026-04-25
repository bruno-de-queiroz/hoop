FROM node:22-alpine

# Hooks are bash scripts that parse JSON with jq.
RUN apk add --no-cache git jq bash

RUN npm install -g @anthropic-ai/claude-code

# Copy the source tree into the image so the installer can register the plugin
# at image-build time.  The plugin registry is stored in Claude Code's data dir
# (not in /build), so the registration survives bind-mount overlays at runtime.
# Build context must be the repo root — see test-infra/claude-runner/Dockerfile
# usage in the test docker build command and CI workflow.
COPY .claude-plugin /build/.claude-plugin
COPY skills        /build/skills
COPY hooks         /build/hooks
COPY dist          /build/dist
COPY node_modules  /build/node_modules

# Bake the installer and run it in copy mode.  This stages the plugin under
# /root/.claude/plugins/hoop and runs `claude plugin marketplace add` +
# `claude plugin install hoop@hoop`, leaving the plugin enabled.
COPY scripts/install-hoop.sh /usr/local/bin/install-hoop
RUN chmod +x /usr/local/bin/install-hoop
ENV HOOP_SRC=/build HOOP_DEST=/root/.claude/plugins/hoop HOOP_INSTALL_MODE=copy
RUN install-hoop

WORKDIR /repo
