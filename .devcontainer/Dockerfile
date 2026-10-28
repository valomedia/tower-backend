# syntax=docker/dockerfile:1
#
# Dev container for tower-backend.
#

FROM mcr.microsoft.com/devcontainers/typescript-node:5.2.3-24-bookworm

ENV PIPX_BIN_DIR=/usr/local/bin \
    PIPX_HOME=/opt/pipx

# renovate: datasource=pypi depName=aws-sam-cli versioning=pep440
ARG AWS_SAM_CLI_VERSION=1.170.0

RUN set -eux; \
    apt-get update; \
    apt-get install --yes --no-install-recommends pipx; \
    rm -rf /var/lib/apt/lists/*; \
    pipx install "aws-sam-cli==${AWS_SAM_CLI_VERSION}"; \
    sam --version
