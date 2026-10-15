# Patches to the application image

Server-side files that LambdaTeX overrides with read-only bind mounts (see
`../toolkit-override.example.yml`). Server code runs from source inside the
container, so these apply without rebuilding the image. Recreate the container
after editing a patch (`bin/docker-compose up -d sharelatex`); single-file mounts
don't pick up in-place edits.

| File | Why |
|---|---|
| `workbench/WorkbenchTools.mjs` | Drops earlier reasoning from the chat history before it goes back to the model. The OpenAI-compatible provider replays it as `reasoning_content`, which Groq rejects (`property 'reasoning_content' is unsupported`). Without this, any follow-up or tool-using chat fails with "Something's gone wrong". Diff: `workbench/WorkbenchTools.mjs.diff`. |
| `workbench/WorkbenchController.mjs` | Registers `save_attached_image` when the chat has images and runs inside a project (project from the Referer), and tells the model to save an image before referencing it. Diff: `workbench/WorkbenchController.mjs.diff`. |
| `workbench/AttachedImageTool.mjs` (new file) | The `save_attached_image` tool: writes an attached JPEG/PNG into the project (default `images/chat-image-<hash>.<ext>`) through Overleaf's `upsertFileWithPath`, after checking write access. A dynamic tool, so the chat client doesn't answer it with "Unknown tool". |

Each patch is made against `ghcr.io/ayaka-notes/overleaf-pro:6.3.0` (upstream commit
`7e6ffc2`). After changing the image tag, run `./check-patches.sh`: `OK` means the
original is unchanged; `CHANGED` means redo the patch from the new file first.
