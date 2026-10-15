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
| `workbench/WorkbenchRouter.mjs` | Adds the saved-conversation routes. Diff: `workbench/WorkbenchRouter.mjs.diff`. |
| `workbench/ConversationStore.mjs`, `workbench/ConversationController.mjs` (new files) | MongoDB storage and HTTP handlers for saved conversations; owner-only. |
| `frontend/workbench/js/…` | Editor UI: `components/conversation-list.tsx` (new), `workbench-panel.tsx`, `workbench-chat.tsx`, `workbench.css`, `hooks/use-file-actions.ts` (the assistant's compile result includes the engine; diffs next to each). Built by `../frontend/build.sh` into `../frontend/builds/<time>/`; `../frontend/dist` points to the current build and is mounted over the image's `public/js`, `stylesheets`, `fonts`, `images` and `manifest.json`. |
| `compile/CompileManager.mjs` | Calls `CompilerAutoSelect` before each compile and, after a compile without PDF, once more if the log asks for another engine. Diff: `compile/CompileManager.mjs.diff`. |
| `compile/CompilerAutoSelect.mjs`, `compile/CompilerDetection.mjs` (new files) | Automatic TeX engine choice: magic comment, packages/classes/commands found by following `\input`/`\include`/`\subfile`/`\import`, local `.sty`/`.cls` and beamer themes; engine-conditional files are left alone. Saves the switch as the project's compiler (if the user may change settings) and pushes it to open editors. `AUTO_COMPILER=false` turns it off. Unit tests: `../tests/compiler_detection_test.mjs`. |
| `workbench/AttachedImageTool.mjs` (new file) | The `save_attached_image` tool: writes an attached JPEG/PNG into the project (default `images/chat-image-<hash>.<ext>`) through Overleaf's `upsertFileWithPath`, after checking write access. A dynamic tool, so the chat client doesn't answer it with "Unknown tool". |

Frontend changes need a rebuild (`deploy/frontend/build.sh`, a few minutes) and a
`bin/docker-compose up -d --force-recreate sharelatex`. The build reuses the image's own
sources and package cache and is reproducible: unchanged bundles come out byte-identical.

Each patch is made against `ghcr.io/ayaka-notes/overleaf-pro:6.3.0` (upstream commit
`7e6ffc2`). After changing the image tag, run `./check-patches.sh`: `OK` means the
original is unchanged; `CHANGED` means redo the patch from the new file first.
