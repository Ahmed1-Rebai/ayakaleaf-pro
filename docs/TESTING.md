# Test results

Run on 2026-10-14 against the lab deployment: Ubuntu 24.04, Docker 29.1.3, Compose v2.29.2,
8 vCPU / 7.8 GB RAM. Image `ghcr.io/ayaka-notes/overleaf-pro:6.3.0` (built from upstream
`7e6ffc2`), TeX Live `ghcr.io/ayaka-notes/texlive-full:2026.1`. The scripts are in
[`deploy/tests/`](../deploy/tests/). They read secrets from `.env` and
`~/.config/ayakaleaf/admin-password`, and never print them.

## Platform (`deploy/tests/e2e_platform.py`)

| Test | Result | Detail |
|---|---|---|
| Web UI up | ✅ PASS | `GET /status` → `web is alive`; `/login`, `/launchpad` → 200 |
| First admin via `/launchpad` | ✅ PASS | `admin@ayakaleaf.local` |
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

## Known limitations

* **Agentic editing not yet verified** (gateway backend outage during testing). Key 1 is over budget.
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
