#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo 'Install Node.js 24 from https://nodejs.org, then open this launcher again.'
  read -r -p 'Press Return to close.'
  exit 1
fi
npm ci --no-audit --no-fund
npm start
