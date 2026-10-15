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
/overleaf/services/web/modules/workbench/app/src/WorkbenchController.mjs 71d81323c48018d07618d36a9435c69493dd51ff4ae418ca82dcff11d3e6c478
/overleaf/services/web/modules/workbench/app/src/WorkbenchRouter.mjs 12ca197210c3bd01cc938ec3773e5cab369ad89ee07b703de8094f95731de54c
/overleaf/services/web/modules/workbench/frontend/js/components/workbench-panel.tsx 8ff221bd9c24b2a85a6391022d9c461343451037079c1f062a521870b40afcdb
/overleaf/services/web/modules/workbench/frontend/js/components/workbench-chat.tsx f7ca14c6e86c787d33e14ae3cf05470a42329a8593fb7c51723b436426a7e320
/overleaf/services/web/modules/workbench/frontend/js/workbench.css 81a0fa832dee74f45487a7b09b7f2106aa3dfd48218a84071b922983f566f6cc
/overleaf/services/web/app/src/Features/Compile/CompileManager.mjs c3d6606943f23261eac42dc5e5d9c2b5eaa3a393dc3bd953ff57cedd8d9bb5a0
/overleaf/services/web/modules/workbench/frontend/js/hooks/use-file-actions.ts 29e7633c3020ae6862c762c852fb8f257121d721e85e2c3aadd70dfb41f5ee0d
/overleaf/services/web/app/src/Features/StaticPages/HomeController.mjs e1133f1fd5e3e788cb0a0fae659f4829c894ea1b8e8eab27282ab12b2aedf836
/overleaf/services/web/app/src/Features/StaticPages/StaticPagesRouter.mjs 82cc6c2f2b512963e66601f608ea862e55279023889498caf82357d051c1b9fc
LIST
exit $status
