#!/usr/bin/env bash
# Check that each patched file's original in the image is still the version the
# patch was written for. Run after changing the image tag; a CHANGED line means
# the patch must be redone from the new upstream file before deploying.
set -euo pipefail
IMAGE="${IMAGE:-ghcr.io/ayaka-notes/overleaf-pro:6.3.0}"
status=0
while read -r path sum; do
  actual=$(docker run --rm --entrypoint sha256sum "$IMAGE" "$path" | cut -d' ' -f1)
  if [ "$actual" = "$sum" ]; then
    echo "OK       $path"
  else
    echo "CHANGED  $path: redo the patch from the image's new version"; status=1
  fi
done <<'LIST'
/overleaf/services/web/modules/workbench/app/src/WorkbenchTools.mjs 6e040abc96627547849c8a6338efb329f8f1025c07f44eb8746c07145bdc3b04
LIST
exit $status
