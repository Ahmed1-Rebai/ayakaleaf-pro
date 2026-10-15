# Project memory (for future agent sessions)

## Context
- Goal: self-hosted Ayakaleaf Pro (Overleaf CE + Pro features, AGPL-3.0), branded LambdaTeX,
  wired to the lab's LiteLLM gateway `http://10.110.150.21:30883/v1`, model
  `palmfuture/Qwen3.6-35B-A3B-GPTQ-Int4` (reads images, no TPM cap). The user prefers
  Qwen3.5-122B via lambda-way once its vLLM backend is up: block kept commented in `.env`.
  gpt-oss-120b on Groq is capped at 8k tokens/min and text-only, so it fails on real files.
- **Repository of record**: GitLab `gitkube.deslabcloud.com/ahmed_rebaii/lambdatex` (project 83),
  cloned at `~/lambdatex`. Deployment-only (no application source; the app runs from the
  published image). Remote `gitlab` over HTTPS; a repo-local credential helper reads
  `~/.config/ayakaleaf/gitkube-token`. SSH (deploy key #11, `~/.ssh/id_ed25519_gitkube`) is
  set up, but gitkube's port 22 is not reachable from this VM.
- Commits: author Ahmed1-Rebai only, never a Co-Authored-By trailer (user preference).
- Upstream source: `ayaka-notes/ayakaleaf-pro` (`server-pro`, image built from `7e6ffc2`).
  The older full fork (GitHub `Ahmed1-Rebai/ayakaleaf-pro`, branch `lab/llm-gateway-deploy`)
  is where this history started; this repo replays only its deployment commits. Its local
  clone was removed when the VM was cleaned (2026-10-14).
- The VM runs only LambdaTeX: Docker holds just overleaf-pro:6.3.0, texlive-full:2026.1,
  mongo:8.0 and redis:7.4 (never `docker image prune -a`: no container keeps TeX Live in use).
  Test output goes to `/tmp/lambdatex-tests` (`LT_TEST_DIR`).

## Deployment layout (host)
- Toolkit: `~/ayakaleaf-toolkit` (`ayaka-notes/toolkit`), `SERVER_PRO=true`, image
  `ghcr.io/ayaka-notes/overleaf-pro:6.3.0`, mongo 8.0, redis 7.4, sibling-container compiles
  with `ghcr.io/ayaka-notes/texlive-full:2026.1` (~29 GB).
- UI: `http://10.110.188.149:8001/` (internal network; `OVERLEAF_LISTEN_IP=0.0.0.0`, `OVERLEAF_PORT=8001`, `OVERLEAF_SITE_URL` set). Plain HTTP. ufw is active but Docker-published ports bypass it. "Connection refused" earlier was a loopback-only binding, not the firewall.
- Admin account comes from `.env` (`SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`) and is applied with
  `deploy/scripts/seed-admin.sh` (idempotent; `--replace old@x` renames an account, keeping its projects).
- Data: `~/ayakaleaf-toolkit/data/{overleaf,mongo,redis}`.
- AI, admin and mail settings and all secrets: **only** `~/lambdatex/.env` (git-ignored, chmod 600), loaded by
  `~/ayakaleaf-toolkit/config/docker-compose.override.yml`. The user explicitly wants a single
  `.env`. Do not create `ai.env` or other copies of the key.

## Branding
- Theme "LambdaTeX" (LAMBDA Lab): `deploy/branding/` (env, CSS, assets, nginx sub_filter
  snippet, asset build tools). Details: `docs/BRANDING.md`.
- Inputs came from the private repo `1dhouha/lambda-website` (3D `.glb` and flat logo).
  Only generated assets are committed (no model file, no website source).
- CSS changes: bump `?v=N` in `deploy/branding/nginx/lambdatex-branding.conf`, then
  `docker exec sharelatex nginx -s reload`.

## AI edit mode and server patch
- `lambdatex.js` adds a Manual / Auto switch under the AI chat prompt (`localStorage`
  `lambdatex.aiEditMode`). Auto clicks the app's own Apply on new two-button suggestion
  cards (`.workbench-code-suggestion`), one at a time, by content fingerprint.
- `deploy/patches/workbench/WorkbenchTools.mjs` (single-file mount) drops earlier reasoning
  from chat history: Groq rejects `reasoning_content`. `WorkbenchController.mjs` +
  new `AttachedImageTool.mjs` add `save_attached_image` (dynamic tool; project from Referer;
  write access checked) so attached photos become project files. Run `deploy/patches/check-patches.sh`
  after any image change; recreate the container after editing a patch.
- Saved conversations: server patches (router, `ConversationStore.mjs`, `ConversationController.mjs`,
  controller `onFinish` save) plus frontend patches in `deploy/patches/frontend/`. Rebuild with
  `deploy/frontend/build.sh` (writes `builds/<time>/`, never deletes; `dist` is a symlink to the
  current build); then recreate with `--force-recreate`. Old `builds/` folders are deleted by hand.
- Automatic TeX engine: `deploy/patches/compile/` (CompileManager patch + `CompilerAutoSelect.mjs` +
  pure `CompilerDetection.mjs`). Runs before every compile, reads docs through the document
  updater (incremental compiles only carry changed docs, so ClsiManager can't do it), saves the
  engine and emits `compilerUpdated`. After a no-PDF compile it reads `output.log` and retries
  once if the log names another engine. Preference xelatex > lualatex (LuaLaTeX rebuilds its font
  cache, ~35 s, in each compile container: TEXMFVAR is in a 64 MB /tmp tmpfs).
  The agent prompt says not to use set_compiler for engine errors; the compile tool returns `compiler`.
- Welcome page: `deploy/patches/home/` (HomeController + StaticPagesRouter patches, `index.pug`).
  CE's global login whitelist is exact-path, so `/` and `/home` are added there. Style is deliberately
  plain (user rejected the gradient/pill/mock-up look as "vibe coded"): real screenshots from
  `deploy/branding/tools/welcome_screenshots.py`, the site's own buttons, no animation.
  The access box points to https://lambdalab.org/ (the lab's services are managed there); `/register`
  still shows the admin email. Short pages: body is a flex column (thin footer) so the footer sits
  at the bottom; don't reintroduce fixed `min-height` values on `main`.
- Auto mode (lambdatex.js) only applies cards created live: cards present when a `.conversation`
  view appears (or within 3 s) are history and wait for Apply. Without this, a reload in Auto
  applied a never-approved restored edit (found and fixed 2026-10-15).
- `save_attached_image` runs without approval, so it never overwrites (free name / reuse by hash).
- AI autocomplete only at word boundaries (spacing by rules in `AutocompleteText.mjs`): chat models
  are unreliable about leading spaces; measured alternatives (space flag, word field, text
  completion) all failed sometimes. Don't reintroduce mid-word suggestions without a FIM model.
- AI autocomplete: server `AutocompleteController.mjs` (thinking off via chat_template_kwargs, ~0.15 s),
  editor `codemirror/ai-autocomplete.ts` + settings section; both frontend entries are added to
  `overleafModuleImports` by `deploy/frontend/register-modules.cjs` during `build.sh` only.
- `deploy/frontend/typecheck.sh`: strict tsc of the frontend patches in a throwaway container
  (`PATCH_DIR` overrides the source; verified to fail on a deliberate error). IDE "Cannot find
  module" errors on these files are expected in this repo.
- API tests must replay reasoning like the browser does; real UI checks need the Playwright
  browser test (`deploy/tests/browser/`).

## Mail
- `.env` holds the user's `Email__*` block (Brevo: smtp-relay.brevo.com:587, STARTTLS, login)
  plus `OVERLEAF_EMAIL_*` lines that interpolate it (compose expands `${Email__…}` in env files).
- Verified: STARTTLS offered and the SMTP login accepted (`nodemailer.verify()`, nothing sent).
  Not verified: real delivery. The sender `contact@lambdalab.org` must be verified in Brevo.
- Overleaf passes no `requireTLS` to nodemailer, so STARTTLS is opportunistic; port 465 with
  `OVERLEAF_EMAIL_SMTP_SECURE=true` would enforce TLS.

## GitHub fork mirror
- `Ahmed1-Rebai/ayakaleaf-pro` branch `lab/llm-gateway-deploy` = upstream `server-pro` + the
  same deployment commits. To mirror new LambdaTex commits: shallow-clone that branch,
  replay each commit's `deploy/ docs/ .env.example memory.md` snapshot with its original
  author/dates, keep `LAMBDATEX.md` = this README, then push (fast-forward, no force).

## Gotchas
- `bin/up` pulls the TeX Live image before starting. Use `SIBLING_CONTAINERS_PULL=false bin/up -d`
  once it is present.
- The override template is `deploy/toolkit-override.example.yml`; its paths assume `/home/user/lambdatex`.
- The published 6.3.0 image is built from `7e6ffc2` and lacks the `mcp-server` module.
- Never `cat`/print `.env`. Check the key with `awk` length or `${#AI_API_KEY}` only.

## Status (2026-10-14)
- Platform: create/save/compile/PDF/zip export/persistence/isolation all PASS.
- AI (current: Qwen3.6-35B): gateway tests, Error Assistant, chat, agentic loop, image chat and
  a ~100k-character document edit all PASS (2026-10-15).
- Earlier gateway (lambda-way, Qwen3.5): key 1 over budget, vLLM backend later down (HTTP 500).
- Mail: Brevo login verified; real delivery not yet confirmed.
- The account `admin@lambdalab.org` has one user project (`aa`); test fixtures are deleted
  after each test run.

## Next steps
1. After any `.env` change: `cd ~/ayakaleaf-toolkit && bin/docker-compose up -d sharelatex`,
   then `python3 deploy/tests/gateway_test.py` (delete test projects after the app tests).
2. Push LambdaTex changes to GitLab `main` (`git push`; `main-clean` is now redundant and can be deleted).
3. Confirm a real Brevo delivery (e.g. "Forgot your password?").
4. Optional: `AI_TOKEN_QUOTA` per user; TLS proxy for non-local access; disable GitLab Auto DevOps.
