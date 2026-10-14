# LLM integration

Ayakaleaf Pro's AI features talk to **one OpenAI-compatible gateway**, configured
entirely through environment variables. No code changes were needed or made.

## Configuration

| Variable | Value used here | Notes |
|---|---|---|
| `AI_ENABLED` | `true` | Master switch (default off). |
| `AI_BASE_URL` | `https://lambda-way.deslabcloud.com/v1` | Must include `/v1`; the SDK appends `/chat/completions`. |
| `AI_MODEL` | `Qwen/Qwen3.5-122B-A10B-GPTQ-Int4` | Used by the chat and the Error Assistant. |
| `AI_API_KEY` | *(secret)* | Sent as `Authorization: Bearer …`. |
| `AI_IMAGE_MODEL` | unset | Optional model for chats that contain images. |
| `AI_MAX_STEPS` | unset (20) | Tool calls per user message. |
| `AI_TOKEN_QUOTA` / `AI_TOKEN_QUOTA_PERIOD` | unset (unlimited) | Per-user token budget counted in Redis. |
| `AI_PROXY_URL` | unset | HTTP proxy for gateway calls. |
| `TAVILY_API_KEY` | unset | Enables the chat's web-search tool. Off here. |
| `DOCS_MCP_URL` | unset (public `docs.overleaf.com` GitBook MCP) | Docs-search tool; set to empty to disable outbound calls. |

**Where the values live:** one file, `.env` at this repository's root. It is
git-ignored (upstream `.gitignore`), `chmod 600`, and loaded into the `sharelatex`
container by `<toolkit>/config/docker-compose.override.yml` (template:
[`deploy/toolkit-override.example.yml`](../deploy/toolkit-override.example.yml)).
Template: [`.env.example`](../.env.example). After changing it, run
`bin/docker-compose up -d sharelatex` in the toolkit.

Upstream code ([ayaka-notes/ayakaleaf-pro](https://github.com/ayaka-notes/ayakaleaf-pro)): `services/web/modules/workbench/index.mjs` (settings),
`…/workbench/app/src/WorkbenchAiClient.mjs` (provider),
`…/error-assistant/app/src/ErrorAssistantController.mjs`.

## How the app uses the gateway

The app uses Vercel AI SDK `ai@6` with `@ai-sdk/openai-compatible@2.0.42`. Every call is
`POST {AI_BASE_URL}/chat/completions` with `stream: true` and
`stream_options.include_usage: true`. The gateway must therefore support:

| Feature | Chat (`POST /workbench/tex-gpt`) | Error Assistant (`POST /project/:id/suggest-fix`) |
|---|---|---|
| Streaming (SSE) | required | required |
| Tool calling (`tools`, streamed `tool_calls` deltas) | required. 12 browser-executed tools (`read_lines`, `read_current_file`, `search_file`, `get_diagnostics`, `list_files`, `create_file`, `open_file`, `replace_lines`, `compile`, `set_compiler`, `view_page`, `view_struct_tree`) | required. One tool, `suggestLineChange`, single step |
| Multi-turn tool results (`role: tool`) | required for agentic loops | not used |
| Usage in final chunk | used for token quotas | used for token quotas |

A vLLM-served Qwen model only returns structured `tool_calls` if the server was started
with `--enable-auto-tool-choice` and a matching `--tool-call-parser`. Gateway-side
configuration decides this, so it has to be tested: OpenAI compatibility alone does not
guarantee it.

### Safety model for agentic editing

* Chat tools have **no server-side `execute`**: the browser runs them against the open
  editor. `replace_lines` edits are shown as a diff and **applied only after the user
  approves**. The model never writes to the project unattended.
* Access requires login. Per-user `aiFeatures.enabled=false` revokes access (checked on
  every request). The Error Assistant also requires read access to the project.
* Tool calls per message are capped by `AI_MAX_STEPS`.
* Server-side tools (web search, docs search) make outbound requests only when enabled.
* The **MCP server** module ("let AI agents edit, compile and comment") exists in the
  repository source but is **not in the published `6.3.0` image**, so it is unavailable
  in this deployment.

## Verified capabilities (2026-10-14)

Tested with the second key (the first key was rejected with `429 budget_exceeded`: it
had spent $10.11 of its $10.00 budget).

| Capability | Status | Evidence |
|---|---|---|
| Config reaches container | ✅ verified | `AI_*` present in `sharelatex`; key length checked, never printed |
| Editor shows AI features | ✅ verified | `aiAvailable: true`; `/workbench/access` → `{"allowed":true,"errorAssistant":true}` |
| Auth + `/models` | ✅ verified | 200, configured model listed; a bogus key → 401 |
| Chat completion | ✅ verified | 3.8 s; returns `reasoning_content` plus the answer |
| Streaming (SSE + `include_usage`) | ✅ verified | 236 chunks, usage in the final chunk |
| Tool calling (non-stream and **streamed** `tool_calls`) | ✅ verified | `finish_reason=tool_calls`, valid JSON arguments |
| Tool-result round-trip (`role: tool`) | ✅ verified | model continues correctly after a tool result |
| Chat via app (`/workbench/tex-gpt`) | ✅ verified | AI SDK UI stream: reasoning → text; 3.6 s |
| LaTeX generation | ✅ verified | generated `tabular` compiled with 0 LaTeX errors |
| Compile-error assistance (`/suggest-fix`) | ✅ verified | for `Environment itemiz undefined` it proposed line 5 `\begin{itemiz}` → `\begin{itemize}` (2.5 s); fix applied and recompiled |
| Agentic editing (multi-step tool loop) | ⚠️ **not yet verified** | test written (`deploy/tests/ai_agentic_test.py`); gateway backend went down before it could run |
| Graceful failure | ✅ verified | gateway errors (429 budget, 500 backend down) → client gets a generic message; details only in server logs |

Observations:
* **Reasoning model.** Qwen3.5 thinks before answering: 285 of 293 completion tokens were
  reasoning in a trivial chat. The AI SDK streams it as `reasoning-*` events. Expect higher
  token usage; consider `AI_TOKEN_QUOTA`.
* **Error Assistant is one-error, one-line.** A typo on two lines (`\begin{itemiz}` and
  `\end{itemiz}`) needs two "Suggest fix" rounds. That's by design (a single
  `suggestLineChange`, `stopWhen: stepCountIs(1)`).
* **Gateway availability.** During testing the gateway's vLLM backend became unreachable
  (`HTTP 500 … Cannot connect to host vllm-svc-coding:8001`) while `/models` still
  returned 200. Use a real chat call, not `/models`, as a health check.

Re-run at any time:

```bash
python3 deploy/tests/gateway_test.py      # direct: auth, chat, stream, tools, stream+tools, round-trip
python3 deploy/tests/ai_app_test.py       # via app: Error Assistant + chat LaTeX generation
python3 deploy/tests/ai_agentic_test.py   # via app: read_current_file -> replace_lines -> compile loop
```
