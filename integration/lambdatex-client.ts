/**
 * LambdaTeX client: use LambdaTeX as a service from another application, for
 * example the lambdalab.org website's backend (Next.js route handlers, server
 * actions, a Node service...). Needs Node 18+ (global fetch, FormData, Blob).
 *
 * SERVER-SIDE ONLY. It signs in as a LambdaTeX "service account" with an email
 * and password, so those credentials must never reach a browser. LambdaTeX does
 * not send CORS headers, so browsers can't call these endpoints from another
 * site anyway; links (editorUrl, openInLambdaTexUrl) are the browser-side part.
 *
 * Users methods need the service account to be a LambdaTeX admin.
 * Reference and examples: docs/INTEGRATION.md. Tested by integration/client.test.ts.
 *
 *   const lambdatex = new LambdaTexClient({
 *     baseUrl: process.env.LAMBDATEX_URL!,          // e.g. http://10.110.188.149:8001
 *     email: process.env.LAMBDATEX_SERVICE_EMAIL!,
 *     password: process.env.LAMBDATEX_SERVICE_PASSWORD!,
 *   })
 *   const projectId = await lambdatex.createProject('Thesis')
 *   const pdf = await lambdatex.downloadPdf(projectId)
 */

export type Compiler = 'pdflatex' | 'xelatex' | 'lualatex' | 'latex'
export type Privileges = 'readAndWrite' | 'readOnly' | 'review'

// Name of projects opened from the website when none is given (LambdaTeX's own
// default still says "Overleaf").
const DEFAULT_PROJECT_NAME = 'LambdaTeX project'
export interface LambdaTexOptions {
  /** Address of LambdaTeX, e.g. "http://10.110.188.149:8001" (no trailing slash needed). */
  baseUrl: string
  /** Service account used for every request. */
  email: string
  password: string
  /** Per-request timeout in milliseconds (default 60 s; compiles may need more). */
  timeoutMs?: number
}

export interface ProjectSummary {
  id: string
  name: string
  accessLevel: string
  lastUpdated: string
  archived: boolean
  trashed: boolean
}

export interface CompileResult {
  /** "success" means a PDF was produced; "failure" means LaTeX errors stopped it. */
  status: string
  /** Absolute URLs of the PDF and log, when produced. Fetch them with fetchFile(). */
  pdfUrl: string | null
  logUrl: string | null
  outputFiles: { path: string; url: string; type: string }[]
}

export interface Member {
  id: string
  email: string
  firstName: string
  lastName: string
  privileges: string
}

export interface AdminUser {
  id: string
  email: string
  firstName?: string
  lastName?: string
  isAdmin?: boolean
  signUpDate?: string
  lastActive?: string
  authMethods?: string[]
  aiFeatures?: { enabled: boolean }
  /** Deleted accounts stay listed (restorable) until purged. */
  deleted?: boolean
  [key: string]: unknown
}

export class LambdaTexError extends Error {
  /** HTTP status of the failed request (0 when there was no response). */
  readonly status: number
  /** Start of the response body, for diagnostics. */
  readonly body: string

  constructor(message: string, status: number, body: string) {
    super(message)
    this.name = 'LambdaTexError'
    this.status = status
    this.body = body
  }
}

type RequestOptions = {
  json?: unknown
  form?: FormData
  query?: Record<string, string | undefined>
  /** Return the raw Response instead of parsing it. */
  raw?: boolean
  /** Internal: skip the automatic sign-in (used by the sign-in itself). */
  anonymous?: boolean
}

export class LambdaTexClient {
  private readonly options: LambdaTexOptions
  private readonly baseUrl: string
  private readonly cookies = new Map<string, string>()
  private csrfToken: string | null = null
  private signingIn: Promise<void> | null = null

  constructor(options: LambdaTexOptions) {
    this.options = options
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
  }

  // ------------------------------------------------------------------ links

  /** Where a signed-in user edits a project. */
  editorUrl(projectId: string): string {
    return `${this.baseUrl}/project/${projectId}`
  }

  /** The user's project dashboard. */
  dashboardUrl(): string {
    return `${this.baseUrl}/project`
  }

  /**
   * "Open in LambdaTeX" link: creates a new project for the visitor from a .tex
   * file or a .zip that LambdaTeX can download (a public URL), then opens it.
   * Visitors who aren't signed in sign in first and the project is created after.
   */
  openInLambdaTexUrl(source: {
    texUrl?: string
    zipUrl?: string
    projectName?: string
    /** File name for texUrl, e.g. "paper.tex" (default: taken from the URL). */
    fileName?: string
    engine?: Compiler
  }): string {
    const query = new URLSearchParams()
    if (source.texUrl) query.set('snip_uri', source.texUrl)
    if (source.zipUrl) query.set('zip_uri', source.zipUrl)
    if (source.fileName) query.set('snip_name', source.fileName)
    query.set('project_name', source.projectName ?? DEFAULT_PROJECT_NAME)
    if (source.engine) query.set('engine', source.engine)
    return `${this.baseUrl}/docs?${query}`
  }

  /**
   * HTML form that opens LaTeX source in LambdaTeX as a new project (POST /docs).
   * Put it in a page of the website; submitting it opens LambdaTeX.
   */
  openInLambdaTexForm(source: { latex: string; projectName?: string; engine?: Compiler; buttonLabel?: string }): string {
    const escape = (value: string) =>
      value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
    return [
      `<form action="${escape(this.baseUrl)}/docs" method="POST" target="_blank">`,
      `  <input type="hidden" name="encoded_snip" value="${escape(encodeURIComponent(source.latex))}">`,
      `  <input type="hidden" name="project_name" value="${escape(source.projectName ?? DEFAULT_PROJECT_NAME)}">`,
      source.engine ? `  <input type="hidden" name="engine" value="${escape(source.engine)}">` : '',
      `  <button type="submit">${escape(source.buttonLabel ?? 'Open in LambdaTeX')}</button>`,
      `</form>`,
    ]
      .filter(Boolean)
      .join('\n')
  }

  // ----------------------------------------------------------------- health

  /** True when LambdaTeX answers. Needs no account. */
  async health(): Promise<boolean> {
    try {
      const response = await this.fetchRaw('GET', '/status')
      return response.ok
    } catch {
      return false
    }
  }

  // --------------------------------------------------------------- projects

  /** Projects the service account owns or can access. */
  async listProjects(): Promise<ProjectSummary[]> {
    const data = await this.request<{ projects: any[] }>('GET', '/user/projects')
    return data.projects.map(p => ({
      id: p._id,
      name: p.name,
      accessLevel: p.accessLevel,
      lastUpdated: p.lastUpdated,
      archived: Boolean(p.archived),
      trashed: Boolean(p.trashed),
    }))
  }

  /** New project, empty ("none") or from the example template. Returns its id. */
  async createProject(name: string, template: 'none' | 'example' = 'none'): Promise<string> {
    const data = await this.request<{ project_id: string }>('POST', '/project/new', {
      json: { projectName: name, template },
    })
    return data.project_id
  }

  /** New project from a .zip of LaTeX sources (main file: main.tex, or the only .tex). */
  async uploadProject(name: string, zip: Uint8Array | ArrayBuffer | Blob): Promise<string> {
    const form = new FormData()
    const fileName = name.endsWith('.zip') ? name : `${name}.zip`
    form.set('name', fileName)
    form.set('qqfile', toBlob(zip, 'application/zip'), fileName)
    const data = await this.request<{ success: boolean; project_id: string }>(
      'POST',
      '/project/new/upload',
      { form }
    )
    if (!data.success || !data.project_id) {
      throw new LambdaTexError('Upload was refused', 422, JSON.stringify(data))
    }
    return data.project_id
  }

  async renameProject(projectId: string, name: string): Promise<void> {
    await this.request('POST', `/project/${projectId}/rename`, { json: { newProjectName: name } })
  }

  /** Compiler used when the project has no "% !TEX program" line (LambdaTeX also picks one automatically). */
  async setCompiler(projectId: string, compiler: Compiler): Promise<void> {
    await this.request('POST', `/project/${projectId}/settings`, { json: { compiler } })
  }

  /** Deletes the project (it can be restored by an admin for a while). */
  async deleteProject(projectId: string): Promise<void> {
    await this.request('DELETE', `/Project/${projectId}`)
  }

  /** Compiles the project. See CompileResult; fetch the PDF with fetchFile(result.pdfUrl). */
  async compile(projectId: string): Promise<CompileResult> {
    const data = await this.request<{ status: string; outputFiles?: any[] }>(
      'POST',
      `/project/${projectId}/compile`,
      { json: { rootDoc_id: null, draft: false, check: 'silent', incrementalCompilesEnabled: true } }
    )
    const outputFiles = (data.outputFiles ?? []).map(f => ({
      path: f.path,
      url: `${this.baseUrl}${f.url}`,
      type: f.type,
    }))
    const find = (path: string) => outputFiles.find(f => f.path === path)?.url ?? null
    return { status: data.status, pdfUrl: find('output.pdf'), logUrl: find('output.log'), outputFiles }
  }

  /** Compiles and returns the PDF. Throws LambdaTexError when no PDF was produced. */
  async downloadPdf(projectId: string): Promise<Uint8Array> {
    const result = await this.compile(projectId)
    if (!result.pdfUrl) {
      throw new LambdaTexError(`Compile produced no PDF (status: ${result.status})`, 422, '')
    }
    return this.fetchFile(result.pdfUrl)
  }

  /** The project's sources as a .zip. */
  async downloadZip(projectId: string): Promise<Uint8Array> {
    const response = await this.request<Response>('GET', `/Project/${projectId}/download/zip`, { raw: true })
    return new Uint8Array(await response.arrayBuffer())
  }

  /** Downloads a compile output (pdfUrl, logUrl...) with the service account's session. */
  async fetchFile(url: string): Promise<Uint8Array> {
    const path = url.startsWith(this.baseUrl) ? url.slice(this.baseUrl.length) : url
    const response = await this.request<Response>('GET', path, { raw: true })
    return new Uint8Array(await response.arrayBuffer())
  }

  // ---------------------------------------------------------------- sharing

  /** Invites someone by email (they get an invitation email and accept it in LambdaTeX). */
  async inviteCollaborator(projectId: string, email: string, privileges: Privileges = 'readAndWrite'): Promise<void> {
    const data = await this.request<{ error?: string }>('POST', `/project/${projectId}/invite`, {
      json: { email, privileges },
    })
    if (data?.error) throw new LambdaTexError(`Invite refused: ${data.error}`, 422, JSON.stringify(data))
  }

  /** People with access to the project (owner excluded). */
  async listMembers(projectId: string): Promise<Member[]> {
    const data = await this.request<{ members: any[] }>('GET', `/project/${projectId}/members`)
    return data.members.map(m => ({
      id: m._id,
      email: m.email,
      firstName: m.first_name,
      lastName: m.last_name,
      privileges: m.privileges,
    }))
  }

  /** Turns on share links and returns them (anyone with the link can open the project after signing in). */
  async enableLinkSharing(projectId: string): Promise<{ readOnlyUrl: string; editUrl: string }> {
    await this.request('POST', `/project/${projectId}/settings/admin`, { json: { publicAccessLevel: 'tokenBased' } })
    const tokens = await this.request<{ readOnly: string; readAndWrite: string }>(
      'GET',
      `/project/${projectId}/tokens`
    )
    return { readOnlyUrl: `${this.baseUrl}/read/${tokens.readOnly}`, editUrl: `${this.baseUrl}/${tokens.readAndWrite}` }
  }

  async disableLinkSharing(projectId: string): Promise<void> {
    await this.request('POST', `/project/${projectId}/settings/admin`, { json: { publicAccessLevel: 'private' } })
  }

  // ---------------------------------------- users (service account must be an admin)

  /**
   * Creates an account. With sso: true the account signs in only through the
   * configured single sign-on (no password, no email). Otherwise LambdaTeX emails
   * an activation link, also returned here so the website can show or send it.
   */
  async createUser(user: { email: string; firstName?: string; lastName?: string; isAdmin?: boolean; sso?: boolean }): Promise<{
    user: AdminUser
    activationLink: string | null
  }> {
    const data = await this.request<{ user: AdminUser }>('POST', '/admin/user/create', {
      json: {
        email: user.email,
        first_name: user.firstName ?? '',
        last_name: user.lastName ?? '',
        isAdmin: Boolean(user.isAdmin),
        isExternal: Boolean(user.sso),
      },
    })
    const activationLink = user.sso ? null : await this.getActivationLink(data.user.id)
    return { user: data.user, activationLink }
  }

  /** Users whose email or name contains `search` (deleted ones included, flagged `deleted`). */
  async findUsers(search: string): Promise<AdminUser[]> {
    const data = await this.request<{ users: AdminUser[] }>('POST', '/admin/users/search', { json: { search } })
    return data.users
  }

  /** Newest users first, `size` at most. */
  async listUsers(size = 50): Promise<{ total: number; users: AdminUser[] }> {
    const data = await this.request<{ totalSize: number; users: AdminUser[] }>('POST', '/admin/users', {
      json: { filters: {}, page: { size }, sort: { by: 'signUpDate', order: 'desc' } },
    })
    return { total: data.totalSize, users: data.users }
  }

  /** Current set-password link of an account that hasn't been activated yet, or null. */
  async getActivationLink(userId: string): Promise<string | null> {
    const data = await this.request<{ activationLink: string | null }>('GET', `/admin/user/${userId}/info`)
    return data.activationLink ?? null
  }

  async resendActivationEmail(userId: string): Promise<void> {
    await this.request('POST', `/admin/user/${userId}/send-activation`)
  }

  /** Changes name, admin rights or access to the AI features. */
  async updateUser(userId: string, changes: { firstName?: string; lastName?: string; isAdmin?: boolean; aiEnabled?: boolean }): Promise<void> {
    const body: Record<string, unknown> = {}
    if (changes.firstName !== undefined) body.firstName = changes.firstName
    if (changes.lastName !== undefined) body.lastName = changes.lastName
    if (changes.isAdmin !== undefined) body.isAdmin = changes.isAdmin
    if (changes.aiEnabled !== undefined) body.aiFeatures = { enabled: changes.aiEnabled }
    await this.request('POST', `/admin/user/${userId}/update`, { json: body })
  }

  /** Projects of any user (admin view). */
  async listUserProjects(userId: string, size = 50): Promise<any[]> {
    const data = await this.request<{ projects: any[] }>('POST', `/admin/user/${userId}/projects`, {
      json: { filters: {}, page: { size }, sort: { by: 'lastUpdated', order: 'desc' } },
    })
    return data.projects
  }

  /**
   * Deletes an account (restorable with restoreUser until purged). Its projects
   * are deleted too, unless transferProjectsTo names another user's id.
   */
  async deleteUser(userId: string, options: { transferProjectsTo?: string } = {}): Promise<void> {
    await this.request('POST', `/admin/user/${userId}/delete`, {
      json: { sendEmail: false, ...(options.transferProjectsTo ? { toUserId: options.transferProjectsTo } : {}) },
    })
  }

  async restoreUser(userId: string): Promise<void> {
    await this.request('POST', `/admin/user/${userId}/restore`)
  }

  /** Permanently removes an account that was deleted before. Cannot be undone. */
  async purgeDeletedUser(userId: string): Promise<void> {
    await this.request('DELETE', `/admin/user/${userId}`)
  }

  // --------------------------------------------------------------- internals

  /** Signs in (done automatically by every method; call it to check credentials early). */
  async login(): Promise<void> {
    this.signingIn ??= (async () => {
      this.cookies.clear()
      this.csrfToken = null
      const token = await this.pageCsrfToken('/login')
      const response = await this.fetchRaw('POST', '/login', {
        json: { email: this.options.email, password: this.options.password },
        csrf: token,
      })
      const body = await response.text()
      if (!response.ok || !/redir/.test(body)) {
        throw new LambdaTexError('Sign-in to LambdaTeX failed: check the service account', response.status, body)
      }
      // The session changes at sign-in; take the token that belongs to it.
      this.csrfToken = await this.pageCsrfToken('/project')
    })().finally(() => {
      this.signingIn = null
    })
    return this.signingIn
  }

  private async request<T = any>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.csrfToken && !options.anonymous) await this.login()
      const response = await this.fetchRaw(method, path, { ...options, csrf: this.csrfToken })
      const expired =
        response.status === 401 ||
        (response.status === 302 && /\/login/.test(response.headers.get('location') ?? ''))
      if (expired && attempt === 0 && !options.anonymous) {
        this.csrfToken = null // session expired: sign in again once
        continue
      }
      if (!response.ok) {
        const body = await response.text()
        throw new LambdaTexError(`${method} ${path} failed with HTTP ${response.status}`, response.status, body.slice(0, 2000))
      }
      if (options.raw) return response as T
      const text = await response.text()
      if (!text) return undefined as T
      try {
        return JSON.parse(text) as T
      } catch {
        return text as T
      }
    }
    throw new LambdaTexError(`${method} ${path}: session could not be renewed`, 401, '')
  }

  private async fetchRaw(
    method: string,
    path: string,
    options: RequestOptions & { csrf?: string | null } = {}
  ): Promise<Response> {
    const url = new URL(this.baseUrl + path)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value)
    }
    const headers: Record<string, string> = { Accept: 'application/json, text/html;q=0.9, */*;q=0.8' }
    if (this.cookies.size) {
      headers.Cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    }
    if (options.csrf) headers['X-Csrf-Token'] = options.csrf
    let body: BodyInit | undefined
    if (options.form) {
      body = options.form
    } else if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(options.json)
    }
    const response = await fetch(url, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
    })
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(';')
      const at = pair.indexOf('=')
      if (at > 0) this.cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
    }
    return response
  }

  private async pageCsrfToken(path: string): Promise<string> {
    const response = await this.fetchRaw('GET', path)
    const html = await response.text()
    const match = /name="ol-csrfToken" content="([^"]+)"/.exec(html)
    if (!match) throw new LambdaTexError(`No CSRF token on ${path}`, response.status, html.slice(0, 500))
    return match[1]
  }
}

function toBlob(content: Uint8Array | ArrayBuffer | Blob | string, type: string): Blob {
  if (content instanceof Blob) return content
  return new Blob([content as BlobPart], { type })
}
