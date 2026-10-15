# LambdaTeX branding

The deployment is rebranded as **LambdaTeX** for the LAMBDA Lab (Laboratory of Advanced
Modeling, Big Data and AI). The palette, type and logo come from the lab's website:
deep navy with electric blue, Inter, and the 3D lambda mark. The upstream image is
unchanged. Everything is configuration plus files mounted read-only.

## How it works

| Piece | File | Mechanism |
|---|---|---|
| Name, nav title, header logos, footers | `deploy/branding/branding.env` | Upstream env vars (`OVERLEAF_APP_NAME`, `OVERLEAF_NAV_TITLE`, `OVERLEAF_HEADER_IMAGE_URL[_LIGHT/_DARK]`, `OVERLEAF_LEFT/RIGHT_FOOTER`) |
| Theme | `deploy/branding/lambdatex/lambdatex.css` | nginx `sub_filter` adds a `<link>` before `</head>` on every HTML page (`deploy/branding/nginx/`, mounted at `/etc/nginx/conf.d/`) |
| Password show/hide | `deploy/branding/lambdatex/lambdatex.js` | Same injection, as `<script defer nonce=…>`. nginx copies the per-request nonce from the app's CSP header, so the policy (`'strict-dynamic'` + nonce) stays unchanged |
| Assets (marks, Inter, icons) | `deploy/branding/lambdatex/` | Mounted at `/overleaf/services/web/public/img/lambdatex/` and served as `/img/lambdatex/…` |
| Favicons, compile-status icons, web manifest | same folder | Mounted over the upstream files in `public/` |
| Overleaf "O" logo (password reset, error pages) | `lambda-logo.svg` | Mounted over `public/img/ol-brand/overleaf-o.svg` and `overleaf-o-dark.svg` |

All mounts and the env file are listed in `deploy/toolkit-override.example.yml`, which is
installed as `<toolkit>/config/docker-compose.override.yml`.

The theme works by:
* remapping Overleaf's `--green-*` accent scale to the lab's blues and its `--neutral-*`
  greys to cool slate. Success states (notifications) stay green.
* overriding the Bootstrap rules that have green compiled in (primary and outline
  buttons, checkboxes, dropdowns, pills).
* setting Inter for body, headings and buttons, and theme tokens for light and dark
  (Overleaf's dark theme is `body[data-theme="default"]`).
* styling the sign-in, registration and reset pages: glass card, 3D mark, glow and dot grid.
  The dashboard gets the lab mark instead of "Digital Science", and the editor gets the mark
  in its toolbar and loading screen.
* adding a show/hide button to password fields on the server-rendered sign-in and password
  pages. It uses Lucide's eye icons (`class="lucide lucide-eye h-4 w-4"`, and `lucide-eye-off`
  while shown), has `aria-label` and `aria-pressed`, and re-hides the password on submit. React
  pages (account settings) are left as they are.
* adding a **Manual / Auto** switch for the AI assistant's edits under the chat prompt
  (Lucide `hand` / `zap` icons). Auto presses the app's own Apply on each new edit, one
  at a time, and never touches the single-button Undo / re-Apply view. See
  `docs/LLM_INTEGRATION.md`, "Safety model".
* toning down the footer: 12 px muted text and a dot instead of the `|`. Upstream's Community
  Edition disclaimer paragraph is hidden (operator's choice; it is not an AGPL requirement).
  The "Powered by Overleaf" and source-code links remain.

## Changing it

* **CSS:** edit `lambdatex.css`, bump `?v=N` in `nginx/lambdatex-branding.conf`, then run
  `docker exec sharelatex nginx -s reload`. `/img/` is cached for a year, so the version
  bump is what makes browsers refetch.
* **Env or mounts:** `cd ~/ayakaleaf-toolkit && bin/docker-compose up -d sharelatex`.
* **Logos:** regenerate with `deploy/branding/tools/` (see its README), then recreate the
  container. Favicons are single-file mounts, so an in-place edit is not picked up until
  the container is recreated.
* **Disable:** remove the `branding.env` line and the `volumes:` block from the override,
  then recreate the container.

## Caveats

* Selectors target upstream markup and CSS variables of image `6.3.0`. After an upgrade,
  check the login page, dashboard (light and dark), editor and password reset.
* The Safari pinned-tab icon (`mask-favicon.svg`) is monochrome by design.
* `/register` shows `OVERLEAF_ADMIN_EMAIL` (set from `Email__FromAddress` in `.env`) as the contact.
* Inter is SIL OFL 1.1 (`lambdatex/Inter-LICENSE.txt`). The Lucide icon paths are ISC.
