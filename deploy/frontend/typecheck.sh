#!/usr/bin/env bash
# Type-checks LambdaTeX's frontend patches (deploy/patches/frontend/) with strict
# TypeScript against the image's real sources and type definitions, in a
# throwaway container. This repo has neither, so an editor shows "Cannot find
# module '@codemirror/state'" and similar for these files; this is the check
# that counts. Only errors in the patched files are reported: upstream files
# they import are not ours to fix. Takes a few minutes.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PATCH_DIR="${PATCH_DIR:-$ROOT/deploy/patches/frontend/workbench}"
IMAGE="${IMAGE:-ghcr.io/ayaka-notes/overleaf-pro:6.3.0}"

docker run --rm --entrypoint sh --memory 6g --memory-swap 9g \
  -e NODE_OPTIONS=--max-old-space-size=5120 \
  -v "$PATCH_DIR:/patch:ro" "$IMAGE" -c '
    set -e
    tar -C /patch --exclude="*.diff" -cf - . | tar -C /overleaf/services/web/modules/workbench/frontend -xf -
    cd /overleaf
    yarn install --immutable > /tmp/install.log 2>&1   # the image links production deps only
    cd services/web
    files=$(cd /patch && find . \( -name "*.ts" -o -name "*.tsx" \) | sed "s|^\./|modules/workbench/frontend/|" | sort)
    node -e "
      const files = process.argv.slice(1)
      require(\"fs\").writeFileSync(\"tsconfig.lambdatex.json\",
        JSON.stringify({ extends: \"./tsconfig.json\", include: [\"types\", ...files] }))
    " $files
    echo "Type-checking $(echo "$files" | wc -l) patched files:"
    echo "$files" | sed "s/^/  /"
    yarn tsc -p tsconfig.lambdatex.json --noEmit > /tmp/tsc.log 2>&1 || true
    node -e "
      const fs = require(\"fs\")
      const files = process.argv.slice(1)
      const lines = fs.readFileSync(\"/tmp/tsc.log\", \"utf8\").split(\"\n\")
      const ours = lines.filter(l => files.some(f => l.startsWith(f + \"(\")))
      const others = lines.filter(l => / error TS\d+/.test(l)).length - ours.length
      if (ours.length) { console.log(ours.join(\"\n\")); console.log(\"FAIL: type errors in patched files\"); process.exit(1) }
      console.log(\"OK: no type errors in the patched files (\" + others + \" in upstream files they import)\")
    " $files
  '
