# Integrating LambdaTeX into the lambdalab.org website

LambdaTeX can be offered from the lab website in three ways, which can be combined:

| Way | What it gives | Where it runs |
|---|---|---|
| [1. Single sign-on (OIDC)](#1-single-sign-on-oidc) | People sign in to LambdaTeX with their lambdalab.org account; the account is created on first sign-in | Configuration of LambdaTeX + an OIDC provider on lambdalab.org |
| [2. Links and "Open in LambdaTeX"](#2-links-and-open-in-lambdatex) | Buttons on the website that open LambdaTeX, or create a project from a `.tex`/`.zip` and open it | Website pages (browser) |
| [3. Server API client](#3-server-api-client) | The website's backend creates accounts, projects and PDFs, shares projects, manages users | Website backend (Node 18+), with `integration/lambdatex-client.ts` |

LambdaTeX currently answers at `http://10.110.188.149:8001` on the lab network. The website's
backend must be able to reach that address. Visitors' browsers must reach it too, for parts 1
and 2. For visitors outside the lab network, LambdaTeX needs a public HTTPS address first.

---

## 1. Single sign-on (OIDC)

This fits "all our services are centralised on the website" best.
- **Sign-in:** the LambdaTeX login page shows a button with your service name, which sends people to lambdalab.org to sign in.
- **Accounts:** on their first sign-in LambdaTeX creates the account, so the website doesn't provision anything. An existing LambdaTeX account with the same email is reused.
- **Requirement:** lambdalab.org must act as an **OpenID Connect provider**, for example Keycloak or Authentik, or an OIDC library in the website.

On the provider, register a client for LambdaTeX with this redirect URL:

```
<LambdaTeX address>/oidc/login/callback     e.g. https://latex.lambdalab.org/oidc/login/callback
```

Then add the following to LambdaTeX's `.env` and recreate the container:

| Variable | Meaning |
|---|---|
| `EXTERNAL_AUTH=oidc` | Turns on OIDC sign-in (`local,oidc` would also keep email/password sign-in, if your image supports combining them; check the login page after the change) |
| `OVERLEAF_OIDC_ISSUER` | The provider's issuer URL |
| `OVERLEAF_OIDC_AUTHORIZATION_URL`, `OVERLEAF_OIDC_TOKEN_URL`, `OVERLEAF_OIDC_USER_INFO_URL` | The provider's endpoints (from its `/.well-known/openid-configuration`) |
| `OVERLEAF_OIDC_CLIENT_ID`, `OVERLEAF_OIDC_CLIENT_SECRET` | The client registered above (keep the secret only in `.env`) |
| `OVERLEAF_OIDC_SCOPE` | Default `openid profile email` |
| `OVERLEAF_OIDC_IDENTITY_SERVICE_NAME` | Label of the sign-in button, e.g. `LAMBDA account` |
| `OVERLEAF_OIDC_ALLOWED_EMAIL_DOMAINS` | Comma-separated domains allowed to sign in, e.g. `lambdalab.org` |
| `OVERLEAF_OIDC_USER_ID_FIELD` | Claim that identifies the user (provider-specific) |
| `OVERLEAF_OIDC_IS_ADMIN_FIELD`, `OVERLEAF_OIDC_IS_ADMIN_FIELD_VALUE` | Optional: a claim/value that makes someone a LambdaTeX admin |
| `OVERLEAF_OIDC_UPDATE_USER_DETAILS_ON_LOGIN` | Update name/email from the provider at each sign-in |
| `OVERLEAF_OIDC_LOGOUT_URL` | Optional: provider logout, used when signing out of LambdaTeX |

These names come from the image's OIDC module (`modules/authentication/oidc`). The setup
**has not been tested here**, because lambdalab.org has no OIDC provider yet. SAML
(`OVERLEAF_SAML_*`) and LDAP (`OVERLEAF_LDAP_*`) are supported the same way.

---

## 2. Links and "Open in LambdaTeX"

These are plain links or forms on website pages, with no API keys. The visitor's own LambdaTeX
account is used. If they're signed out, LambdaTeX asks them to sign in and then continues.

| Link | Opens |
|---|---|
| `<LambdaTeX>/` | The welcome page (signed out) or the project list (signed in) |
| `<LambdaTeX>/project` | The visitor's projects |
| `<LambdaTeX>/project/<projectId>` | A project in the editor |
| `<LambdaTeX>/docs?snip_uri=<url of a .tex>` | **New project** from a `.tex` file that LambdaTeX can download, opened in the editor |
| `<LambdaTeX>/docs?zip_uri=<url of a .zip>` | New project from a `.zip` of sources |
| `&project_name=My paper` | Project name. Always pass one: LambdaTeX's default is "Open in Overleaf project" |
| `&engine=xelatex` / `&snip_name=paper.tex` | Optional: compiler; file name for `snip_uri` |

To open LaTeX written on the page itself (a template, an example), POST it as a form. This is
the only cross-site POST that LambdaTeX accepts:

```html
<form action="http://10.110.188.149:8001/docs" method="POST" target="_blank">
  <input type="hidden" name="encoded_snip" value="%5Cdocumentclass%7Barticle%7D%0A...">  <!-- encodeURIComponent(latex) -->
  <input type="hidden" name="project_name" value="My paper">
  <input type="hidden" name="engine" value="pdflatex">
  <button type="submit">Open in LambdaTeX</button>
</form>
```

`openInLambdaTexUrl()` and `openInLambdaTexForm()` in the client build these for you, with
"LambdaTeX project" as the default name. Tested: a signed-in POST creates the project, with
the given name and `main.tex`, and opens it; signed out, it goes to the login page first.

---

## 3. Server API client

`integration/lambdatex-client.ts` is a dependency-free TypeScript client for the **website's
backend**: Next.js route handlers or server actions, or any Node 18+ service. Copy it into the
website's code base.

### Setup

1. **Create a service account** in LambdaTeX, for example `website@lambdalab.org`, with a
   strong password.
   - To create, update or delete users, it must be an **admin**.
   - For projects only, a normal account is enough and safer.
2. **Give the website's server three environment variables.** Never expose them to browsers:
   ```
   LAMBDATEX_URL=http://10.110.188.149:8001
   LAMBDATEX_SERVICE_EMAIL=website@lambdalab.org
   LAMBDATEX_SERVICE_PASSWORD=...
   ```
3. Create one client and reuse it. It signs in on first use, keeps the session, and signs in again
   automatically when the session expires:
   ```ts
   import { LambdaTexClient } from '@/lib/lambdatex-client'
   export const lambdatex = new LambdaTexClient({
     baseUrl: process.env.LAMBDATEX_URL!,
     email: process.env.LAMBDATEX_SERVICE_EMAIL!,
     password: process.env.LAMBDATEX_SERVICE_PASSWORD!,
   })
   ```

LambdaTeX's endpoints use a session cookie and a CSRF token, not API keys, and send no CORS
headers. The client handles both, which is why it must run on the server.

### Methods

All methods are `async`. A failure throws `LambdaTexError`, which carries `status` (HTTP) and `body`.

**Service and links**

| Method | HTTP | Notes |
|---|---|---|
| `health()` | `GET /status` | `true` when LambdaTeX answers; no account needed |
| `login()` | `GET /login`, `POST /login` | Done automatically; call it at start-up to fail fast on wrong credentials |
| `editorUrl(projectId)`, `dashboardUrl()` | — | Links for the website's pages |
| `openInLambdaTexUrl({ texUrl \| zipUrl, projectName?, fileName?, engine? })` | `GET /docs?…` | See part 2 |
| `openInLambdaTexForm({ latex, projectName?, engine?, buttonLabel? })` | `POST /docs` | Returns escaped HTML for a page |

**Projects** (owned by, or shared with, the service account)

| Method | HTTP | Notes |
|---|---|---|
| `listProjects()` | `GET /user/projects` | `{ id, name, accessLevel, lastUpdated, archived, trashed }[]` |
| `createProject(name, template?)` | `POST /project/new` | `template`: `'none'` (default) or `'example'`; returns the id |
| `uploadProject(name, zip)` | `POST /project/new/upload` | New project from a `.zip` (`Uint8Array`, `ArrayBuffer` or `Blob`) |
| `renameProject(projectId, name)` | `POST /project/:id/rename` | |
| `setCompiler(projectId, compiler)` | `POST /project/:id/settings` | `pdflatex`, `xelatex`, `lualatex`, `latex` (the engine is also chosen automatically) |
| `compile(projectId)` | `POST /project/:id/compile` | `{ status, pdfUrl, logUrl, outputFiles }`; `status` is `success` when a PDF was produced |
| `downloadPdf(projectId)` | compile + `GET <pdfUrl>` | PDF bytes; throws if the LaTeX doesn't produce a PDF |
| `fetchFile(url)` | `GET <url>` | Any compile output, e.g. `logUrl` |
| `downloadZip(projectId)` | `GET /Project/:id/download/zip` | Sources as `.zip` bytes |
| `deleteProject(projectId)` | `DELETE /Project/:id` | Restorable by an admin for a while |

**Sharing**

| Method | HTTP | Notes |
|---|---|---|
| `inviteCollaborator(projectId, email, privileges?)` | `POST /project/:id/invite` | `readAndWrite` (default), `readOnly` or `review`; LambdaTeX emails the invitation |
| `listMembers(projectId)` | `GET /project/:id/members` | `{ id, email, firstName, lastName, privileges }[]` (owner not included) |
| `enableLinkSharing(projectId)` | `POST /project/:id/settings/admin`, `GET /project/:id/tokens` | Returns `{ readOnlyUrl, editUrl }`; anyone with a link can join after signing in |
| `disableLinkSharing(projectId)` | `POST /project/:id/settings/admin` | Makes the project private again |

**Users** (service account must be an admin)

| Method | HTTP | Notes |
|---|---|---|
| `createUser({ email, firstName?, lastName?, isAdmin?, sso? })` | `POST /admin/user/create`, `GET /admin/user/:id/info` | Returns `{ user, activationLink }`. Normal accounts get an activation email from LambdaTeX, and the same set-password link is returned so the website can show it. `sso: true` creates an account that signs in only through SSO (no password, no email). With OIDC (part 1) accounts are created at first sign-in, so this is rarely needed |
| `findUsers(search)` | `POST /admin/users/search` | Matches email or name; deleted accounts are included with `deleted: true` |
| `listUsers(size?)` | `POST /admin/users` | Newest first: `{ total, users }` |
| `getActivationLink(userId)` | `GET /admin/user/:id/info` | Current set-password link, or `null` once used |
| `resendActivationEmail(userId)` | `POST /admin/user/:id/send-activation` | |
| `updateUser(userId, { firstName?, lastName?, isAdmin?, aiEnabled? })` | `POST /admin/user/:id/update` | `aiEnabled: false` turns off the AI features for that person |
| `listUserProjects(userId, size?)` | `POST /admin/user/:id/projects` | Admin view of anyone's projects |
| `deleteUser(userId, { transferProjectsTo? })` | `POST /admin/user/:id/delete` | Restorable until purged. Their projects are deleted too, unless transferred to another user id |
| `restoreUser(userId)` | `POST /admin/user/:id/restore` | |
| `purgeDeletedUser(userId)` | `DELETE /admin/user/:id` | Permanent |

### Examples

The website's "Request LambdaTeX access" form approves a member, and the website shows the
set-password link:

```ts
// app/api/lambdatex/access/route.ts (Next.js)
import { lambdatex } from '@/lib/lambdatex'
import { LambdaTexError } from '@/lib/lambdatex-client'

export async function POST(request: Request) {
  const { email, firstName, lastName } = await request.json() // after your own auth/approval checks
  try {
    const { activationLink } = await lambdatex.createUser({ email, firstName, lastName })
    return Response.json({ ok: true, activationLink })
  } catch (err) {
    if (err instanceof LambdaTexError && err.status === 409) {
      return Response.json({ ok: false, reason: 'This email already has a LambdaTeX account.' }, { status: 409 })
    }
    throw err
  }
}
```

Build a PDF on the server, for example a generated report:

```ts
const projectId = await lambdatex.uploadProject('Monthly report', zipBytes)
const pdf = await lambdatex.downloadPdf(projectId)   // Uint8Array, starts with %PDF
await lambdatex.deleteProject(projectId)
return new Response(pdf, { headers: { 'Content-Type': 'application/pdf' } })
```

Give a lab member a copy of a template **in their own account**: use a link (part 2), not the
service account:

```tsx
<a href={lambdatex.openInLambdaTexUrl({ zipUrl: 'https://lambdalab.org/templates/thesis.zip', projectName: 'My thesis', engine: 'xelatex' })}>
  Start my thesis in LambdaTeX
</a>
```

### Limits

- **Editing files one by one is not available over HTTP.** LambdaTeX edits files over the
  editor's live connection. To change a project's content from the website, upload a new `.zip`
  (`uploadProject`) or open it for the user (part 2).
- **Projects created by the service account belong to the service account.** Share them
  (`inviteCollaborator`, `enableLinkSharing`), or use part 2 so the project is created in the
  person's own account.
- **Invitation and activation emails** go through LambdaTeX's mail settings (Brevo). Real
  delivery hasn't been confirmed yet (see `memory.md`).
- **The AI assistant and autocomplete** are editor features. Their endpoints are internal and
  not part of this API.
- **These are LambdaTeX's web endpoints, not a versioned public API.** After upgrading the
  LambdaTeX image, run the client test below before deploying.
- **Rate limits:** LambdaTeX's own limits apply, for example to sign-in attempts and compiles.
  Reuse one client rather than signing in for every request.

### Testing the client

`integration/client.test.ts` exercises every method against a running LambdaTeX:
- it creates and deletes two projects and one SSO-only test user, so no email is sent;
- it sends no invitations.

Node 22.18+ or 24 runs TypeScript directly:

```bash
LAMBDATEX_URL=http://127.0.0.1:8001 LAMBDATEX_SERVICE_EMAIL=... LAMBDATEX_SERVICE_PASSWORD=... \
  node integration/client.test.ts
```

On this VM, without Node installed, run it in the LambdaTeX image:

```bash
cd ~/lambdatex && docker run --rm --network host --entrypoint node -v "$PWD/integration:/i:ro" \
  -e LAMBDATEX_URL=http://127.0.0.1:8001 \
  -e LAMBDATEX_SERVICE_EMAIL="$(sed -n 's/^SEED_ADMIN_EMAIL=//p' .env)" \
  -e LAMBDATEX_SERVICE_PASSWORD="$(sed -n 's/^SEED_ADMIN_PASSWORD=//p' .env)" \
  ghcr.io/ayaka-notes/overleaf-pro:6.3.0 /i/client.test.ts
```

Result on 2026-10-15: 26/26 passed. The client also passes a strict TypeScript 5.9 check
(`strict`, `erasableSyntaxOnly`).
