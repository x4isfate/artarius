#!/bin/sh
# Раздел CHANGELOG.md для версии $1 — текст релиза на GitHub.
awk -v v="## $1" '$0 == v { on = 1; next } /^## / && on { exit } on' CHANGELOG.md
