# Project memory (for future agent sessions)

## Context
- Goal: self-hosted Ayakaleaf Pro (Overleaf CE + Pro features, AGPL-3.0) wired to the lab's
  OpenAI-compatible LLM gateway `https://lambda-way.deslabcloud.com/v1`, model
  `Qwen/Qwen3.5-122B-A10B-GPTQ-Int4`.
- Upstream: `ayaka-notes/ayakaleaf-pro`, default branch `server-pro`, forked at `5d3575b`.
- Fork: `Ahmed1-Rebai/ayakaleaf-pro`; working branch `lab/llm-gateway-deploy`.
  Local clone `~/ayakaleaf-pro`: `origin` = fork, `upstream` = ayaka-notes (push disabled).
  Git auth: a repo-local credential helper reads `~/.config/ayakaleaf/gh-token` (chmod 600).
- No application code changes. Only docs, `.env.example`, `deploy/` templates and tests.

## Deployment layout (host)
- Toolkit: `~/ayakaleaf-toolkit` (`ayaka-notes/toolkit`), `SERVER_PRO=true`, image
  `ghcr.io/ayaka-notes/overleaf-pro:6.3.0`, mongo 8.0, redis 7.4, sibling-container compiles
  with `ghcr.io/ayaka-notes/texlive-full:2026.1` (~29 GB).
- UI: `http://127.0.0.1/` (localhost only). Admin `admin@ayakaleaf.local`, password in
  `~/.config/ayakaleaf/admin-password`.
- Data: `~/ayakaleaf-toolkit/data/{overleaf,mongo,redis}`.
- AI config + secret: **only** `~/ayakaleaf-pro/.env` (git-ignored, chmod 600), loaded by
  `~/ayakaleaf-toolkit/config/docker-compose.override.yml`. The user explicitly wants a single
  `.env`. Do not create `ai.env` or other copies of the key.
- The repo's root `docker-compose.yml` is stock Overleaf CE. Don't use it.

## Gotchas
- `bin/up` pulls the TeX Live image before starting. Use `SIBLING_CONTAINERS_PULL=false bin/up -d`
  once it is present.
- Upstream `.gitignore` ignores `docker-compose.override.yml`, so the template is
  `deploy/toolkit-override.example.yml`.
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
