// End-to-end test of lambdatex-client.ts against a running LambdaTeX.
// Node 22.18+/24 runs it directly (built-in TypeScript type stripping):
//   LAMBDATEX_URL=http://127.0.0.1:8001 LAMBDATEX_SERVICE_EMAIL=... LAMBDATEX_SERVICE_PASSWORD=... \
//   node integration/client.test.ts
// The service account must be an admin for the users part. Creates and deletes
// two projects and one SSO-only test user (no email is sent); sends no invitations.
import { LambdaTexClient, LambdaTexError } from './lambdatex-client.ts'
import zlib from 'node:zlib'

const env = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`Set ${name}`)
  return value
}
const lambdatex = new LambdaTexClient({
  baseUrl: env('LAMBDATEX_URL'),
  email: env('LAMBDATEX_SERVICE_EMAIL'),
  password: env('LAMBDATEX_SERVICE_PASSWORD'),
  timeoutMs: 180_000,
})

const results: Record<string, boolean> = {}
function check(name: string, ok: boolean, detail = '') {
  results[name] = ok
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`)
}

// Minimal .zip writer (stored, no compression) for the upload test.
function zip(files: Record<string, string>): Uint8Array {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text)
    const nameBytes = Buffer.from(name)
    const crc = zlib.crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    parts.push(local, nameBytes, data)
    central.push(entry, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...parts, ...central, end]))
}

const startsWith = (bytes: Uint8Array, text: string) => Buffer.from(bytes.slice(0, text.length)).toString() === text
const created: string[] = []
const TEX = '\\documentclass{article}\n\\begin{document}\nHello from the integration test.\n\\end{document}\n'

try {
  // ---------------------------------------------------------- service
  check('health() without an account', await lambdatex.health())
  const wrong = new LambdaTexClient({ baseUrl: env('LAMBDATEX_URL'), email: env('LAMBDATEX_SERVICE_EMAIL'), password: 'wrong-password' })
  let refused = false
  try { await wrong.login() } catch (err) { refused = err instanceof LambdaTexError }
  check('login() with a wrong password throws LambdaTexError', refused)
  await lambdatex.login()
  check('login() with the service account', true)

  // --------------------------------------------------------- projects
  const blank = await lambdatex.createProject('lt-integration blank')
  created.push(blank)
  check('createProject() returns an id', /^[0-9a-f]{24}$/.test(blank), blank)
  const fromZip = await lambdatex.uploadProject('lt-integration zip', zip({ 'main.tex': TEX }))
  created.push(fromZip)
  check('uploadProject() from a .zip', /^[0-9a-f]{24}$/.test(fromZip), fromZip)
  const listed = await lambdatex.listProjects()
  check('listProjects() includes both', created.every(id => listed.some(p => p.id === id)), `${listed.length} projects`)

  const compiled = await lambdatex.compile(blank)
  check('compile() produces a PDF', compiled.status === 'success' && Boolean(compiled.pdfUrl), compiled.status)
  const pdf = await lambdatex.downloadPdf(fromZip)
  check('downloadPdf() returns a PDF', startsWith(pdf, '%PDF'), `${pdf.length} bytes`)
  const sources = await lambdatex.downloadZip(blank)
  check('downloadZip() returns a .zip', startsWith(sources, 'PK'), `${sources.length} bytes`)
  const log = compiled.logUrl ? Buffer.from(await lambdatex.fetchFile(compiled.logUrl)).toString() : ''
  check('fetchFile(logUrl) returns the log', log.startsWith('This is'), log.slice(0, 30))

  await lambdatex.renameProject(blank, 'lt-integration renamed')
  check('renameProject()', (await lambdatex.listProjects()).some(p => p.id === blank && p.name === 'lt-integration renamed'))
  await lambdatex.setCompiler(blank, 'xelatex')
  check('setCompiler()', true)
  check('listMembers() of a private project is empty', (await lambdatex.listMembers(blank)).length === 0)
  const links = await lambdatex.enableLinkSharing(blank)
  check('enableLinkSharing() returns read-only and edit links', /\/read\/[a-z]+$/.test(links.readOnlyUrl) && /\/[0-9]+[a-z]+$/.test(links.editUrl), JSON.stringify(links))
  await lambdatex.disableLinkSharing(blank)
  check('disableLinkSharing()', true)

  // ------------------------------------------------------------ links
  check('editorUrl()', lambdatex.editorUrl(blank).endsWith(`/project/${blank}`))
  const openUrl = lambdatex.openInLambdaTexUrl({ texUrl: 'https://example.org/paper.tex', projectName: 'My paper', engine: 'xelatex' })
  check('openInLambdaTexUrl()', openUrl.includes('/docs?snip_uri=https%3A%2F%2Fexample.org%2Fpaper.tex&project_name=My+paper&engine=xelatex'), openUrl)
  const form = lambdatex.openInLambdaTexForm({ latex: TEX })
  check('openInLambdaTexForm() escapes the LaTeX, names the project', form.includes('name="encoded_snip"') && !form.includes('\\documentclass') && form.includes('%5Cdocumentclass') && form.includes('value="LambdaTeX project"'))

  // ------------------------------------------------------------- users
  const email = `lt-integration-test-${Date.now()}@example.org`
  const { user, activationLink } = await lambdatex.createUser({ email, firstName: 'Integration', lastName: 'Test', sso: true })
  check('createUser() (SSO-only: no password, no email)', user.email === email && activationLink === null, user.id)
  const found = await lambdatex.findUsers('lt-integration-test')
  check('findUsers()', found.some(u => u.id === user.id))
  await lambdatex.updateUser(user.id, { firstName: 'Renamed', aiEnabled: false })
  const updated = (await lambdatex.findUsers(email))[0]
  check('updateUser() name and AI access', updated?.firstName === 'Renamed' && updated?.aiFeatures?.enabled === false, JSON.stringify({ firstName: updated?.firstName, ai: updated?.aiFeatures }))
  const page = await lambdatex.listUsers(5)
  check('listUsers()', page.total >= 2 && page.users.length >= 1, `${page.total} users`)
  check('listUserProjects() of a new user is empty', (await lambdatex.listUserProjects(user.id)).length === 0)
  await lambdatex.deleteUser(user.id)
  check('deleteUser() (still listed, flagged deleted, until purged)', (await lambdatex.findUsers(email)).find(u => u.id === user.id)?.deleted === true)
  await lambdatex.purgeDeletedUser(user.id)
  check('purgeDeletedUser()', true)
} catch (err) {
  console.log('ERROR', err instanceof LambdaTexError ? `${err.message} | ${err.status} | ${err.body.slice(0, 300)}` : err)
  results['no unexpected error'] = false
} finally {
  for (const id of created) {
    try { await lambdatex.deleteProject(id) } catch {}
  }
  const left = (await lambdatex.listProjects()).filter(p => created.includes(p.id))
  check('deleteProject() removes the test projects', left.length === 0)
}

const failed = Object.entries(results).filter(([, ok]) => !ok).map(([name]) => name)
console.log(`\nSUMMARY ${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed${failed.length ? `; failed: ${failed.join(', ')}` : ''}`)
process.exit(failed.length ? 1 : 0)
