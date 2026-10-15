# LLM integration

Ayakaleaf Pro's AI features talk to **one OpenAI-compatible gateway**, configured
entirely through environment variables. No code changes were needed or made.

## Configuration

| Variable | Value used here | Notes |
|---|---|---|
| `AI_ENABLED` | `true` | Master switch (default off). |
| `AI_BASE_URL` | `http://10.110.150.21:30883/v1` | Lab LiteLLM gateway on the internal network. Must include `/v1`; the SDK appends `/chat/completions`. |
| `AI_MODEL` | `palmfuture/Qwen3.6-35B-A3B-GPTQ-Int4` | Used by the chat and the Error Assistant. Self-hosted behind the lab gateway; reads images, no per-minute token cap. |
| `AI_API_KEY` | *(secret)* | Sent as `Authorization: Bearer …`. |
| `AI_IMAGE_MODEL` | unset | Optional model for chats that contain images. Unset: images go to `AI_MODEL`, which must then read images. |
| `AI_MAX_STEPS` | `12` | Tool calls per user message (upstream default 20). A backstop against endless re-edits. |
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

A self-hosted vLLM model only returns structured `tool_calls` if the server was started
with `--enable-auto-tool-choice` and a matching `--tool-call-parser`. Gateway-side
configuration decides this, so it has to be tested: OpenAI compatibility alone does not
guarantee it.

### Safety model for agentic editing

* Chat tools run in the browser against the open editor (no server-side `execute`), except
  `save_attached_image` (below). How `replace_lines` edits are applied depends on the **edit mode** switch under
  the prompt (added by LambdaTeX, `deploy/branding/lambdatex/lambdatex.js`):
  * **Manual** (default): each edit is shown as a diff and **applied only after the user
    clicks Apply** (or Reject).
  * **Auto**: each edit that arrives while Auto is on is applied through the same Apply
    action, one at a time. The app still opens the file, checks that `existingContent`
    matches, and reports back to the model. **Undo** stays on every applied edit, and
    project history keeps every change. Only edits that arrive while the conversation is
    open are applied: edits already waiting when Auto is switched on, and edits in a
    conversation shown from history (page load, reload, reopened from the list) wait for
    Apply. The choice is per browser (`localStorage`).
  The compile-log Error Assistant is not affected: its fixes are always applied by hand.
* Without approval, in either mode, the assistant can only read files, compile, create a
  **new empty** file (`create_file` refuses existing paths), change the Compiler setting
  (`set_compiler`), and save an image attached in the chat (`save_attached_image`, run on
  the server after a write-access check). That tool **never replaces a file**: a taken name
  gets `-2`, `-3`… and the same image is reused. Changing the text of a file always goes
  through `replace_lines`.
* Access requires login. Per-user `aiFeatures.enabled=false` revokes access (checked on
  every request). The Error Assistant also requires read access to the project.
* Tool calls per message are capped by `AI_MAX_STEPS`.
* Server-side tools (web search, docs search) make outbound requests only when enabled.
* The **MCP server** module ("let AI agents edit, compile and comment") exists in the
  repository source but is **not in the published `6.3.0` image**, so it is unavailable
  in this deployment.

## Verified capabilities (2026-10-15)

Current: LiteLLM at `http://10.110.150.21:30883/v1`, model `palmfuture/Qwen3.6-35B-A3B-GPTQ-Int4`.

The gateway's models, tested for what the assistant needs:

| Model | Chat | Tool calling | ~29k-token request | Image | Verdict |
|---|---|---|---|---|---|
| `palmfuture/Qwen3.6-35B-A3B-GPTQ-Int4` | ✅ | ✅ | ✅ 6.5 s | ✅ | **in use** |
| `groq/openai/gpt-oss-120b` | ✅ | ✅ | ❌ Groq on-demand tier: 8,000 tokens/min | ❌ text-only | fails on real documents and images |
| `Qwen/Qwen3.5-122B-A10B-GPTQ-Int4` (also via lambda-way) | ❌ backend down (`vllm-svc-coding:8001`) | | | | preferred once it's back; settings kept commented in `.env` |

| Capability (Qwen3.6-35B) | Status | Evidence |
|---|---|---|
| Direct gateway: auth, chat, stream, tools, streamed tools, tool round-trip | ✅ verified | `gateway_test.py` all PASS |
| Compile-error assistance (`/suggest-fix`) | ✅ verified | both `itemiz` lines fixed in one round (~21 s) |
| Chat LaTeX generation | ✅ verified | correct `table`/`tabular`, 2.2 s |
| Agentic editing (read → replace_lines → compile) | ✅ verified | 0 errors; reasoning replayed like the browser |
| Image attached to a chat | ✅ verified | colour of an attached PNG identified |
| "Insert this photo" with an image attached | ✅ verified | `save_attached_image` → `images/chat-image-….png` in the project → `\includegraphics` with that path → compiles (`ai_image_test.py`) |
| Large document (~100k characters): "remove the navbar of the first page" | ✅ verified | read the file, added `\thispagestyle{empty}` after `\maketitle`, compiles |
| Edit mode Manual / Auto, editor UI | ✅ verified (2026-10-14) | `deploy/tests/browser/` |

Observations:
* **Reasoning history.** Earlier reasoning is not sent back to the model (server patch in
  `deploy/patches/`): some gateways reject it, and models don't need it.
* **Images in chat** let the model see a picture. When it should go into the document (e.g.
  "insert my photo at the bottom"), the assistant calls `save_attached_image`, which saves
  the JPEG/PNG into the project (`images/chat-image-<hash>.<ext>`) and returns the path it
  then uses in `\includegraphics` (server patch in `deploy/patches/`). Other formats must
  be converted to PNG/JPEG first.
* **Speed.** Qwen3.6 reasons before answering, so simple chats take 1–3 s and the Error
  Assistant up to ~20 s. gpt-oss on Groq was faster but is capped at 8,000 tokens per minute.
* **Error Assistant is one-error, one-line.** A typo on two lines (`\begin{itemiz}` and
  `\end{itemiz}`) needs two "Suggest fix" rounds. That's by design (a single
  `suggestLineChange`, `stopWhen: stepCountIs(1)`). The chat agent fixes both in one edit.
* **History.** The first gateway (`https://lambda-way.deslabcloud.com/v1`, Qwen3.5-122B on
  self-hosted vLLM) passed the same direct tests, but its key hit its budget and its vLLM
  backend went down (`HTTP 500 … Cannot connect to host vllm-svc-coding:8001`) while
  `/models` still returned 200. Use a real chat call, not `/models`, as a health check. Its
  settings are kept as comments in `.env`.

Re-run at any time:

```bash
python3 deploy/tests/gateway_test.py      # direct: auth, chat, stream, tools, stream+tools, round-trip
python3 deploy/tests/ai_app_test.py       # via app: Error Assistant + chat LaTeX generation
python3 deploy/tests/ai_agentic_test.py   # via app: read_current_file -> replace_lines -> compile loop
```

## Saved conversations

Conversations are stored server-side in MongoDB (`workbenchConversations`), one document
per conversation: owner, project, title, the AI SDK UI messages, timestamps.

* **Saving:** automatic when each reply finishes (`onFinish` of the reply stream, with
  `originalMessages` so the whole conversation is saved). The editor sends the chat id and
  project id; the user must be able to read the project.
* **Endpoints** (login required, own conversations only): `GET /workbench/conversations?project_id=`,
  `GET /workbench/conversations/:id`, `POST /workbench/conversations/:id/rename`,
  `DELETE /workbench/conversations/:id`.
* **Privacy:** every query includes the owner's user id. Another user cannot read, rename,
  delete, overwrite or list them (tested). Titles come from the first message.
* **Size:** very long conversations (>8 MB, mostly inline images) drop their oldest
  images and keep a short note instead.
* **UI:** 🕘 **Conversations** in the assistant's header: the list for this project (newest
  first, active marked), reopen, inline rename, delete with confirmation, **New
  conversation**. The last conversation is resumed when the project is reopened.

Server code: `deploy/patches/workbench/` (router, store, endpoints, controller). Frontend:
`deploy/patches/frontend/`, built by `deploy/frontend/build.sh`.

## Decisiveness

Qwen3.6 used to loop through many small edit, compile and view cycles. The system prompt
now asks it to read what it needs, make the complete change in as few `replace_lines` calls
as possible, compile and check at most once, then stop and summarise, and to ask the user
after two failed attempts. `AI_MAX_STEPS=12` caps tool calls per message. On the
"caption under the image" task: 4 tool calls (read, edit, retry, compile) instead of 20+.
## TeX engine choice

The server chooses the engine on every compile, including the assistant's `compile` tool
(`deploy/patches/compile/`, described in `README.md`). For the assistant:

* The system prompt explains the rule: add the package and compile; don't call
  `set_compiler` for engine errors; use `% !TEX program = …` only when the user asks for an
  engine; if there's still no PDF, fix the first error; it also lists installed fonts
  to use when a font is missing.
* The `compile` and `get_diagnostics` results include `compiler`, the engine the editor
  now has, so the assistant can say what was used.

## AI autocomplete

Inline suggestions in the source editor (grey ghost text; Tab accepts, Esc dismisses).

* **Server:** `POST /workbench/autocomplete { projectId, path, prefix, suffix }` →
  `{ completion }` (`deploy/patches/workbench/AutocompleteController.mjs`). Login, AI access,
  the user's AI consent and write access to the project are required; the token quota counts
  it; 120 requests/minute per user. The model's thinking is switched off
  (`chat_template_kwargs: { enable_thinking: false }`): with Qwen3.6 a suggestion takes about
  0.15 s; with thinking on it used all its tokens on reasoning and returned nothing. If a
  gateway rejects that option it is dropped automatically.
* **Prompt:** the text before and after the cursor (3,000 / 1,000 characters) with a cursor
  mark; one line at most, same language as the document.
* **Word boundaries only:** suggestions are made after a space, punctuation, a bracket or `$`,
  or at the start of a line, never inside or right after a word. A chat model can't be trusted
  to say whether its text continues a word or starts a new one: measured on Qwen3.6, plain
  replies dropped the space before a new word ("are" + "powerful" → "arepowerful"), an
  explicit `space` flag was wrong about 1 time in 10, asking for the word at the cursor gave
  the wrong word, and plain text completion broke mid-word. At a boundary the spacing is fixed
  by rules (`AutocompleteText.mjs`): none after whitespace, an opening bracket, `$`, `~`, `-`,
  `/` or `'`; one space after `.`, `,`, `;`, `:`, `!`, `?` or a closing bracket when a word
  follows. The reply is also cleaned: no repeated text, no duplicate of an auto-closed `}`/`$`,
  no comma after a finished sentence, one line.
* **Editor:** a CodeMirror extension (`deploy/patches/frontend/workbench/js/codemirror/
  ai-autocomplete.ts`) asks 450 ms after you stop typing, at the end of a line, in LaTeX
  files, in Code mode. It skips command names and `\cite`/`\ref`/`\label`/file arguments,
  waits while Overleaf's completion list or a snippet is active or IME input is being
  composed, and cancels the request as soon as you type again. A suggestion survives edits
  elsewhere in the document (e.g. a collaborator's); after a 429 (rate limit or quota) it
  waits a minute before asking again.
* **Settings:** Settings → Editor → AI autocomplete (per browser). `AI_AUTOCOMPLETE=true` is
  set in `.env` (also the default); `false` turns the endpoint off; `AI_AUTOCOMPLETE_MODEL` uses another model on the same gateway.
