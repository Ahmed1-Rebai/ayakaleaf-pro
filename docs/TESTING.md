# Test results

Run on 2026-10-14 against the lab deployment: Ubuntu 24.04, Docker 29.1.3, Compose v2.29.2,
8 vCPU / 7.8 GB RAM. Image `ghcr.io/ayaka-notes/overleaf-pro:6.3.0` (built from upstream
`7e6ffc2`), TeX Live `ghcr.io/ayaka-notes/texlive-full:2026.1`. The scripts are in
[`deploy/tests/`](../deploy/tests/). They read secrets, including the admin
account (`SEED_ADMIN_*`), from `.env` and never print them.

## Platform (`deploy/tests/e2e_platform.py`)

| Test | Result | Detail |
|---|---|---|
| Web UI up | ✅ PASS | `GET /status` → `web is alive`; `/login`, `/launchpad` → 200 |
| First admin via `/launchpad` | ✅ PASS | initial account; later renamed by the `.env` seed (see below) |
| Login (session + CSRF) | ✅ PASS | |
| Create project (zip upload) | ✅ PASS | |
| Compile → PDF | ✅ PASS | `status=success`, 2.2 s first compile, valid `%PDF-` (49,764 B) |
| Save (overwrite `main.tex`) and recompile | ✅ PASS | 1.1 s, new PDF (52,315 B) |
| Export source zip | ✅ PASS | contains the saved edit marker |
| Persistence across `bin/docker-compose down` + `bin/up -d` | ✅ PASS | containers removed and recreated; login, project content and recompile all OK |
| Compile isolation | ✅ PASS | per-project sibling container, user `www-data`, `CapDrop=ALL`, 1 GiB memory limit, only that project's compile dir mounted |
| Compile error captured in log | ✅ PASS | `! LaTeX Error: Environment itemiz undefined.` (nonstop mode still emits a PDF) |

## AI

Two keys were used. **Key 1** was rejected on every call with `429 budget_exceeded`
("Current cost: 10.106953, Max budget: 10.0"), so it could not reach the model. **Key 2**
results are below.

### Direct gateway (`deploy/tests/gateway_test.py`, key 2)

| Test | Result | Detail |
|---|---|---|
| Auth + `/models` | ✅ PASS | 200, configured model listed |
| Invalid key rejected | ✅ PASS | 401 |
| Chat completion | ✅ PASS | 3.8 s, `GATEWAY-OK`; usage 312 tokens (285 reasoning) |
| Streaming | ✅ PASS | 236 SSE chunks, `1 2 3 4 5`, usage in the final chunk |
| Tool calling | ✅ PASS | `finish_reason=tool_calls`, `suggestLineChange` with `\begin{itemize}` |
| Streaming tool calling | ✅ PASS | streamed `tool_calls` deltas assemble into valid JSON |
| Tool-result round-trip | ✅ PASS | coherent reply after a `role: tool` message |

### Through the app (`deploy/tests/ai_app_test.py`, key 2)

| Test | Result | Detail |
|---|---|---|
| `GET /workbench/access` | ✅ PASS | `{"allowed":true,"errorAssistant":true}` |
| Editor exposes AI | ✅ PASS | `aiAvailable: true` |
| No key → refused cleanly | ✅ PASS | `403 ai_not_configured` |
| Error Assistant (`/suggest-fix`) | ✅ PASS | 2.5 s; `main.tex:5 \begin{itemiz} → \begin{itemize}` |
| AI fix applied → recompile | ✅ PASS (expected partial) | that error is gone; the second typo (`\end{itemiz}`, line 7) remains as a new, separate error |
| Second "Suggest fix" round | ⚠️ NOT RUN | gateway backend down: `HTTP 500 … Cannot connect to host vllm-svc-coding:8001` |
| Chat LaTeX generation (`/workbench/tex-gpt`) | ✅ PASS | 3.6 s; stream reasoning → text; generated table compiles with 0 errors |
| Agentic editing (`deploy/tests/ai_agentic_test.py`) | ⚠️ NOT RUN | same gateway outage |
| Gateway errors surfaced safely | ✅ PASS | 429 and 500 → generic client message; the SDK retries 3 times; details in `bin/logs web` |

## Branding (LambdaTeX theme)

Checked with headless Chromium (Playwright) screenshots at 1440×900, and at 390×844 for the login page.

| Check | Result |
|---|---|
| Theme stylesheet injected and served (`/img/lambdatex/lambdatex.css`) | ✅ |
| `nginx -t` with the branding snippet | ✅ |
| Login, password reset, account settings, admin, dashboard, editor (light) | ✅ visually reviewed |
| Dashboard and editor in dark theme | ✅ after fixing a contrast bug in the first version |
| Editor loading screen shows the LambdaTeX mark | ✅ |
| Favicons, status icons, manifest replaced (200, correct MIME) | ✅ |
| Phone width login: no horizontal overflow | ✅ |
| Platform E2E (login, create, compile, save, export) after rebranding | ✅ PASS |

## AI on the current gateway (LiteLLM `10.110.150.21:30883`, `groq/openai/gpt-oss-120b`)

| Test | Result | Detail |
|---|---|---|
| `gateway_test.py`: auth + models / bad key | ✅ PASS | 200, 3 models, configured model listed / 401 |
| chat · streaming | ✅ PASS | 0.3 s, `GATEWAY-OK` · 33 SSE chunks, usage in final chunk |
| tools · streamed tools · tool round-trip | ✅ PASS | `suggestLineChange` with valid JSON; coherent reply after `role: tool` |
| `ai_app_test.py`: Error Assistant | ✅ PASS | line 5 `\begin{itemiz}` → `\begin{itemize}`, 0.7 s |
| `ai_app_test.py`: chat LaTeX generation | ✅ PASS | reasoning → text stream, correct `tabular`, 1.4 s |
| `ai_agentic_test.py`: agentic editing | ✅ PASS | `read_current_file` → `replace_lines` (lines 5–7) → `compile`: 0 errors → summary. This first version didn't replay reasoning, so it missed the browser failure below |

## Automatic TeX engine (2026-10-15)

| Test | Result |
|---|---|
| Wrong engine in TeX Live 2026 (`texlive-full:2026.1`): fontspec, polyglossia, ctex, `\RequireXeTeX` give **no PDF** under pdfLaTeX; unicode-math, xeCJK, luacode, luatexja give errors | baseline recorded |
| `compiler_detection_test.mjs`: magic comments, packages, classes, commands, `\input`/`\import`/local `.sty`/`.cls`/beamer themes, comments and `\iffalse`, engine-conditional templates, conflicts, cycles, log messages | ✅ 50/50 |
| `compiler_auto_test.py` (real compiles, project set to the wrong engine): fontspec, `\directlua`, ctexart, CV `.cls`, `\input` preamble, magic comment, plain doc keeps XeLaTeX, conditional template keeps pdfLaTeX, log fallback (hidden package name), edit flow | ✅ 11/11 (engine from the log's first line; saved setting checked) |
| `browser/ai_compiler_test.py`: assistant (Auto) sets Arial with fontspec on a pdfLaTeX project: 3 tool calls, compile reports `xelatex`, no `set_compiler`, no "didn't produce a PDF"; Recompile button with the setting forced back to pdfLaTeX gives a PDF | ✅ 7/7 |
| Frontend rebuild: same 2 webpack warnings as before | ✅ |

Timing: XeLaTeX/pdfLaTeX compiles take 1–3 s; LuaLaTeX ~36 s (font cache rebuilt in each compile container).

## Saved conversations and decisiveness (2026-10-15)

| Test | Result |
|---|---|
| `ai_conversations_test.py` (API): auto-save, title, reopen, continue, rename, 404/400 checks, delete | ✅ 10/10 |
| Isolation (store, two users): no read, rename, delete, overwrite or listing of another user's conversation | ✅ 7/7 |
| `browser/ai_conversations_test.py` (editor): button, two conversations, New conversation, list order/active, reopen, **reload resumes**, rename (persisted), delete, delete the active one | ✅ 12/12 |
| Frontend build: same 2 webpack warnings as the unmodified baseline; only `pages/ide` js/css changed | ✅ |
| Decisiveness, "add a caption under the image" | ✅ 4 tool calls, compiles (previously 20+) |

## Model switch to Qwen3.6-35B (2026-10-15)

Reported in the editor: an image in the chat and "remove the navbar of the first page" both
ended in "Something's gone wrong". Server log: Groq `messages[3].content must be a string`
(gpt-oss is text-only) and `Request too large … TPM: Limit 8000, Requested 22451`.

| Test (Qwen3.6-35B) | Result |
|---|---|
| `gateway_test.py` (7 checks) | ✅ all PASS |
| `ai_app_test.py`: Error Assistant, chat LaTeX | ✅ PASS |
| `ai_agentic_test.py` | ✅ PASS |
| Image attached to a chat (via `/workbench/tex-gpt`, as the browser sends it) | ✅ PASS |
| ~100k-character document with a `fancyhdr` header: "remove the navbar of the first page" | ✅ PASS: `\thispagestyle{empty}` after `\maketitle`, compiles |
| "Insert this photo" with an image attached, before the image patch | ❌ the model wrote `\includegraphics{photo.jpg}` for a file that didn't exist: `File 'photo.jpg' not found` |
| Same with `save_attached_image` (`ai_image_test.py`) | ✅ PASS: saved as `images/chat-image-….png`, referenced by that path, compiles |

## AI edit mode and reasoning patch (real editor, Playwright)

| Test | Result | Detail |
|---|---|---|
| Real-editor chat that uses a tool, before the patch | ❌ FAIL | AI read the file, then "Something's gone wrong": Groq `property 'reasoning_content' is unsupported` |
| Same, with `deploy/patches/workbench/WorkbenchTools.mjs` mounted | ✅ PASS | read → replace_lines in one turn |
| Switch under the prompt, default Manual | ✅ PASS | `manual=true auto=false` |
| Manual: pending edit leaves the document unchanged; Apply fixes it | ✅ PASS | |
| Auto: edit applied with no click; saved per browser | ✅ PASS | `localStorage` `lambdatex.aiEditMode=auto`; 2 Undo buttons, 0 pending |
| `ai_agentic_test.py` replaying reasoning (as the browser does) | ✅ PASS | read → replace_lines ×2 → compile: 0 errors |
| `check-patches.sh` | ✅ OK | the image's original still matches the patched version |

## Admin seed, password toggle, mail (2026-10-14)

| Check | Result | Detail |
|---|---|---|
| `seed-admin.sh --replace admin@ayakaleaf.local` | ✅ PASS | `admin@lambdalab.org: renamed …; password updated; isAdmin true` |
| Seed again (idempotency) | ✅ PASS | `exists; password unchanged; isAdmin true` |
| Login with `.env` admin; old email rejected | ✅ PASS | new: `/project`, 9 projects kept, Admin menu present; old: stays on `/login` |
| Platform E2E using `.env` credentials | ✅ PASS | login, create, compile, save, recompile, export |
| Password toggle (Playwright) | ✅ PASS | icon `lucide lucide-eye h-4 w-4` → click → `type=text`, `lucide-eye-off`, `aria-pressed=true` → click → `password`; no CSP violations |
| Script nonce equals the CSP header nonce | ✅ PASS | checked on `/login` |
| First mail config (`host.docker.internal:25`) | ❌ FAIL | `ECONNREFUSED 172.17.0.1:25`: no relay on this VM; "Forgot your password?" returned 500. Replaced by Brevo |
| Mail settings resolved in Overleaf (Brevo) | ✅ PASS | from `Lambda Research Lab <contact@lambdalab.org>`, `smtp-relay.brevo.com:587`, STARTTLS, auth set |
| Brevo reachable, STARTTLS offered | ✅ PASS | EHLO lists `STARTTLS`, AUTH `PLAIN LOGIN CRAM-MD5` |
| SMTP login (`nodemailer.verify()`: connect + STARTTLS + AUTH, no message) | ✅ PASS | credentials accepted |
| Real message delivery | ⚠️ NOT RUN | needs an actual send; the sender must be verified in Brevo |

## Known limitations

* **Mail delivery not yet confirmed**: SMTP login to Brevo works; no real message has been sent.

* The first gateway (Qwen3.5 via lambda-way) is unusable: key 1 over budget, vLLM backend down. The
  current gateway passes everything, including agentic editing.
* The browser UI (chat panel, diff approval) was exercised via its HTTP/stream protocol, not by clicking in a real browser.
* **MCP server not available**: its module is in the source tree but not in the published
  `6.3.0` image (which is 44 commits behind upstream `5d3575b`). Using it would require
  building the image from source.
* **Compile containers have network access** (Docker `bridge`, upstream default).
* **Not tested**: browser-driven interactive editing over WebSocket (saving was tested via
  the upload API), git-bridge, GitHub/GitLab sync, Zotero/Mendeley, SSO, email delivery
  (no SMTP configured), Python runner, HTTPS proxy.
* The app logs the gateway's error body, which includes the gateway's key alias and a
  masked key suffix (not the full key).
