#!/bin/sh
set -e
mkdir -p "${DATA_DIR:-/data}"
chown node:node "${DATA_DIR:-/data}"
exec su-exec node "$@"
