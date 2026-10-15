#!/usr/bin/env bash
# Rebuild the editor frontend with LambdaTeX's patches (deploy/patches/frontend/)
# in a throwaway container from the same image. Each build goes to its own
# folder, deploy/frontend/builds/<timestamp>/, owned by the caller, and
# deploy/frontend/dist is a symlink to the current one: the toolkit override
# mounts dist/ over the image's public/ assets. Nothing is deleted; remove old
# folders under builds/ yourself once the new build is live.
# Takes a few minutes and up to ~6 GB of RAM.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${IMAGE:-ghcr.io/ayaka-notes/overleaf-pro:6.3.0}"
BUILDS="$ROOT/deploy/frontend/builds"
DIST="$ROOT/deploy/frontend/dist"
STAMP="$(date +%Y%m%d-%H%M%S)"
NEW="$BUILDS/$STAMP"
mkdir -p "$NEW"

docker run --rm --entrypoint sh --memory 6g --memory-swap 9g \
  -e NODE_OPTIONS=--max-old-space-size=5120 -e OWNER="$(id -u):$(id -g)" \
  -v "$ROOT/deploy/patches/frontend/workbench:/patch:ro" -v "$NEW:/out" "$IMAGE" -c '
    set -e
    tar -C /patch --exclude="*.diff" -cf - . | tar -C /overleaf/services/web/modules/workbench/frontend -xf -
    cd /overleaf
    yarn install --immutable > /out/install.log 2>&1   # the image links production deps only
    cd services/web
    yarn run webpack:production > /out/build.log 2>&1
    cp -r public/js public/stylesheets public/fonts public/images public/manifest.json /out/
    chown -R "$OWNER" /out
  '

test -s "$NEW/manifest.json" || { echo "Build failed: see $NEW/build.log" >&2; exit 1; }
ln -sfn "builds/$STAMP" "$DIST"
echo "Built $(ls "$NEW/js" | wc -l) js files into $NEW (dist -> builds/$STAMP)"
echo "Apply: cd ~/ayakaleaf-toolkit && bin/docker-compose up -d --force-recreate sharelatex"
