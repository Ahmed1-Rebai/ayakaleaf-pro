# Project memory (for future agent sessions)

## Context
- Goal: self-hosted Ayakaleaf Pro (Overleaf CE + Pro features, AGPL-3.0), branded LambdaTeX,
  wired to the lab's OpenAI-compatible LLM gateway `https://lambda-way.deslabcloud.com/v1`,
  model `Qwen/Qwen3.5-122B-A10B-GPTQ-Int4`.
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

## Mail
- `.env` holds the user's `Email__*` block (Brevo: smtp-relay.brevo.com:587, STARTTLS, login)
  plus `OVERLEAF_EMAIL_*` lines that interpolate it (compose expands `${Email__…}` in env files).
- Verified: STARTTLS offered and the SMTP login accepted (`nodemailer.verify()`, nothing sent).
  Not verified: real delivery. The sender `contact@lambdalab.org` must be verified in Brevo.
- Overleaf passes no `requireTLS` to nodemailer, so STARTTLS is opportunistic; port 465 with
  `OVERLEAF_EMAIL_SMTP_SECURE=true` would enforce TLS.

## Gotchas
- `bin/up` pulls the TeX Live image before starting. Use `SIBLING_CONTAINERS_PULL=false bin/up -d`
  once it is present.
- The override template is `deploy/toolkit-override.example.yml`; its paths assume `/home/user/lambdatex`.
- The published 6.3.0 image is built from `7e6ffc2` and lacks the `mcp-server` module.
- Never `cat`/print `.env`. Check the key with `awk` length or `${#AI_API_KEY}` only.

## Status (2026-10-14)
- Platform: create/save/compile/PDF/zip export/persistence/isolation all PASS.
- AI key 1: `429 budget_exceeded` ($10.11 of $10.00). User switched to key 2 in `.env`.
- AI key 2: gateway auth/chat/stream/tools/stream-tools/round-trip PASS; app Error Assistant
  and chat LaTeX generation PASS. Agentic loop test (`deploy/tests/ai_agentic_test.py`)
  NOT RUN: the gateway's vLLM backend (`vllm-svc-coding:8001`) went down (HTTP 500).

## Next steps
1. When the gateway backend is back (a real chat call returns 200), run
   `python3 deploy/tests/ai_agentic_test.py` and a second Error Assistant round.
2. After any `.env` change: `cd ~/ayakaleaf-toolkit && bin/docker-compose up -d sharelatex`.
3. Test chat agentic editing in a browser (approve a `replace_lines` diff).
4. Update `docs/LLM_INTEGRATION.md` and `docs/TESTING.md` with the real results.
5. Optional: set `AI_TOKEN_QUOTA` per user; TLS proxy for non-local access; sync the fork
   (`git fetch upstream && git merge upstream/server-pro`).
