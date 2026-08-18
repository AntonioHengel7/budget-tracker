#!/bin/sh
set -e
chown -R node:node "${DATA_DIR:-/data}"
exec su-exec node "$@"
