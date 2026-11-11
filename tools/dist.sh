#!/bin/sh
# Собирает архив для релиза: dist/artarius.zip и dist/module.json.
# Ссылка download в dist/module.json всегда ведёт на релиз текущей версии.
set -e
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist
zip -qr dist/artarius.zip module.json LICENSE README.md CHANGELOG.md docs scripts templates styles lang
node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync("module.json", "utf8"));
m.download = `https://github.com/x4isfate/artarius/releases/download/v${m.version}/artarius.zip`;
fs.writeFileSync("dist/module.json", JSON.stringify(m, null, 2) + "\n");
'
ls -la dist
