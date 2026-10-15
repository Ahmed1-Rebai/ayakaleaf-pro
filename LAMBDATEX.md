# LambdaTeX

The LAMBDA Lab's self-hosted LaTeX platform. LambdaTeX runs **Ayakaleaf Pro**
(Overleaf Community Edition with Pro features) from its published image. This repository
holds only the lab's deployment: configuration, branding, admin and mail setup, AI
gateway integration, and tests. It contains no application source code.

| | |
|---|---|
| Application | [`ghcr.io/ayaka-notes/overleaf-pro:6.3.0`](https://github.com/ayaka-notes/ayakaleaf-pro), run with [`ayaka-notes/toolkit`](https://github.com/ayaka-notes/toolkit) |
| Compiles | sandboxed, one `ghcr.io/ayaka-notes/texlive-full:2026.1` container per project |
| AI | lab LiteLLM gateway, `palmfuture/Qwen3.6-35B-A3B-GPTQ-Int4` (reads images) ([docs/LLM_INTEGRATION.md](docs/LLM_INTEGRATION.md)) |
| Mail | Brevo SMTP relay |
| Look | LambdaTeX theme ([docs/BRANDING.md](docs/BRANDING.md)) |
| URL | http://10.110.188.149:8001/ (internal network) |

## Repository layout

```
deploy/
  branding/                LambdaTeX theme: CSS, JS, logos, icons, Inter, nginx snippet, env
    tools/                 scripts that regenerate the logo set from the lab website's assets
  scripts/seed-admin.*     create or update the admin account from .env
  tests/                   platform, gateway, AI and agentic end-to-end tests
  toolkit-override.example.yml   becomes <toolkit>/config/docker-compose.override.yml
  patches/                 server-side file overrides (mounted read-only) and their check script
docs/                      LLM integration, branding, test results
.env.example               every setting, placeholders only (the real .env is git-ignored)
memory.md                  context for future maintenance sessions
```

## Setup

Requirements: Docker with Compose v2, about 35 GB free disk (the TeX Live image alone is
about 29 GB), and 4 GB or more of RAM.

```bash
git clone https://gitkube.deslabcloud.com/ahmed_rebaii/lambdatex.git ~/lambdatex
git clone https://github.com/ayaka-notes/toolkit.git ~/ayakaleaf-toolkit
cd ~/ayakaleaf-toolkit && bin/init
sed -i 's/^SERVER_PRO=false/SERVER_PRO=true/' config/overleaf.rc
sed -i 's/^OVERLEAF_PORT=.*/OVERLEAF_PORT=8001/; s/^OVERLEAF_LISTEN_IP=.*/OVERLEAF_LISTEN_IP=0.0.0.0/' config/overleaf.rc
# in config/variables.env set:
#   TEX_LIVE_DOCKER_IMAGE=ghcr.io/ayaka-notes/texlive-full:2026.1
#   ALL_TEX_LIVE_DOCKER_IMAGES=ghcr.io/ayaka-notes/texlive-full:2026.1
#   OVERLEAF_SITE_URL=http://<host-ip>:8001

# All secrets and AI/admin/mail settings: ONE git-ignored file
cp ~/lambdatex/.env.example ~/lambdatex/.env        # then fill it in
chmod 600 ~/lambdatex/.env
cp ~/lambdatex/deploy/toolkit-override.example.yml config/docker-compose.override.yml
chmod 600 config/variables.env config/docker-compose.override.yml

bin/up -d                                  # first run pulls about 30 GB of images
~/lambdatex/deploy/scripts/seed-admin.sh   # creates the admin account from .env
```

The override template assumes the repository is at `/home/user/lambdatex`. Adjust the
paths if you cloned it elsewhere.

## Operations

```bash
cd ~/ayakaleaf-toolkit
bin/up -d                    # start
bin/stop                     # stop, keep containers
bin/start                    # start stopped containers
bin/docker-compose down      # remove containers (data is kept in data/)
bin/docker-compose up -d sharelatex   # apply changes to .env, the override or branding.env
bin/logs -f web              # app logs (also: clsi, real-time, document-updater, ...)
bin/doctor                   # environment diagnostics
```

Data lives in `~/ayakaleaf-toolkit/data/{overleaf,mongo,redis}`. Back up all three.

The UI listens on port 8001 on all interfaces of the host (`OVERLEAF_LISTEN_IP=0.0.0.0`).
It is plain HTTP, so put a TLS proxy in front (`bin/init --tls`) for anything beyond
internal use. Self-registration is off: create accounts at `/admin/register`.

## Admin account and mail

The admin account is defined in `.env` (`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`):

```bash
deploy/scripts/seed-admin.sh                             # create, or update the password; idempotent
deploy/scripts/seed-admin.sh --replace old@example.org   # rename an existing account (keeps its projects)
```

The script passes the values to the container over stdin, so they never appear in process
arguments. Passwords go through Overleaf's normal policy checks.

Mail uses the `Email__*` block in `.env` (Brevo, port 587 with STARTTLS), which is mapped
onto Overleaf's `OVERLEAF_EMAIL_*` variables in the same file. The sender address must be
verified in the Brevo account.

## Usage

Create a project from the dashboard, edit it, and press **Recompile**. Download the PDF, or
the source with **Menu → Download → Source (zip)**. The editor has an AI chat panel, and
compile errors get a **Suggest fix** button. The switch under the chat prompt chooses how
the assistant's edits are applied: **Manual** (default) shows each one as a diff to Apply or
Reject; **Auto** applies them as they arrive, with **Undo** on each. To put a photo in the
document, attach it in the chat and ask (e.g. "insert my photo at the bottom"): the assistant
saves it into the project under `images/` and includes it.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `bin/up` hangs before starting containers | It pulls the ~29 GB TeX Live image first. Pull it separately, or run `SIBLING_CONTAINERS_PULL=false bin/up -d`. |
| AI chat: "The AI service returned an error" | `bin/logs web \| grep -iE "tex-gpt\|suggest-fix"`. `budget_exceeded` (429) means the key's spend limit is reached. `Cannot connect to host vllm-…` (500) means the gateway's model server is down. |
| AI panel missing / `403 ai_not_configured` | `AI_ENABLED`, `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL` must be set: `docker exec sharelatex sh -c 'echo ${#AI_API_KEY}'` should print a non-zero length. |
| "Forgot your password?" → *Something went wrong* (500) | Mail relay unreachable or login rejected: `bin/logs web \| grep -iE "smtp\|ECONN"`. Check the `Email__*` values. |
| `seed-admin.sh` fails with `contains_email` / `too_similar` | Overleaf rejects passwords that contain or resemble the email address. |
| Not reachable from other machines | `docker port sharelatex` must show `0.0.0.0:8001`. A timeout instead of a refusal points to a network firewall. |
| AI chat: "Something's gone wrong" on a large file or with an image | `bin/logs web \| grep -iE "RateLimit\|content must be a string"`: the model's provider caps tokens per minute or doesn't accept images (Groq `gpt-oss-120b`). Use a model without those limits (see `docs/LLM_INTEGRATION.md`). |
| AI chat: "Something's gone wrong" after the assistant uses a tool | `bin/logs web \| grep -i reasoning_content`: the reasoning-history patch isn't mounted. Check `deploy/patches/` and the override. |
| Theme change not visible | Bump `?v=N` in `deploy/branding/nginx/lambdatex-branding.conf`, then run `docker exec sharelatex nginx -s reload`. |

## Credits and licence

LambdaTeX is built on [Overleaf](https://github.com/overleaf/overleaf) (© Overleaf,
2014–2025) and [Ayakaleaf Pro](https://github.com/ayaka-notes/ayakaleaf-pro) (© Pro
Authors, 2026–), both under the GNU AGPL v3. This repository is released under the same
licence ([LICENSE](LICENSE)). Inter is SIL OFL 1.1 (`deploy/branding/lambdatex/Inter-LICENSE.txt`).
The Lucide icons are ISC. LambdaTeX is not affiliated with Overleaf or Digital Science.
