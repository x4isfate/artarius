#!/bin/sh
# Собирает архив для релиза: dist/artarius.zip и dist/module.json.
set -e
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist
zip -qr dist/artarius.zip module.json LICENSE README.md CHANGELOG.md docs scripts templates styles lang
cp module.json dist/module.json
ls -la dist
