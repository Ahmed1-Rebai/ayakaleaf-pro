import { v4 as uuid } from 'uuid'
import {
  createGitToken,
  gitClone,
  gitCommitAndPush,
  workingCopy,
} from '../../../helpers/git'
import { login } from '../../../helpers/login'
import {
  createProject,
  openProject,
  projectName,
} from '../../../helpers/project'
import { requestWithCsrf } from '../../../helpers/request'
import { shareProject, shareProjectByLink } from '../../../helpers/sharing'
import { ensureUserExists } from '../../../helpers/users'

// The MCP server of a project (/project/:id/mcp), next to git-bridge: the
// same personal access tokens authenticate MCP clients and git.

const owner = `owner-${uuid()}@example.com`
const viewer = `viewer-${uuid()}@example.com`
const stranger = `stranger-${uuid()}@example.com`

const MAIN_TEX = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Pushed through git',
  '\\end{document}',
  '',
].join('\n')

type ToolResult = {
  content: { type: string; text: string }[]
  isError?: boolean
}

before(function () {
  for (const email of [owner, viewer, stranger]) {
    ensureUserExists(email)
  }
})

// A JSON-RPC request the way MCP clients send it over Streamable HTTP
function mcp(
  projectId: string,
  token: string | null,
  method: string,
  params: Record<string, unknown> = {}
) {
  return cy.request({
    method: 'POST',
    url: `/project/${projectId}/mcp`,
    headers: {
      Accept: 'application/json, text/event-stream',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: { jsonrpc: '2.0', id: 1, method, params },
    failOnStatusCode: false,
  })
}

function callTool(
  projectId: string,
  token: string,
  name: string,
  args: Record<string, unknown> = {}
): Cypress.Chainable<ToolResult> {
  return mcp(projectId, token, 'tools/call', { name, arguments: args }).then(
    response => {
      expect(response.status).to.equal(200)
      return response.body.result as ToolResult
    }
  )
}

function toolJson(result: ToolResult) {
  expect(result.isError, result.content[0].text).not.to.equal(true)
  return JSON.parse(result.content[0].text)
}

type Compile = {
  status: string
  buildId: string
  clsiServerId?: string
  outputFiles: string[]
}

// Overleaf refuses a compile within a second of the previous one
function compile(projectId: string, token: string): Cypress.Chainable<Compile> {
  return callTool(projectId, token, 'compile')
    .then(toolJson)
    .then((build: Compile) => {
      if (build.status !== 'too-recently-compiled') return build
      cy.wait(1000)
      return compile(projectId, token)
    })
}

function outputFileLink(
  projectId: string,
  token: string,
  build: Compile,
  file?: string
): Cypress.Chainable<string> {
  return callTool(projectId, token, 'get_output_file_link', {
    buildId: build.buildId,
    clsiServerId: build.clsiServerId,
    file,
  }).then(result => {
    expect(result.isError).not.to.equal(true)
    return result.content[0].text
  })
}

// The links point at the site URL; Cypress requests the path
function download(link: string) {
  return cy.request({
    url: new URL(link).pathname,
    encoding: 'binary',
    failOnStatusCode: false,
  })
}

describe('MCP server of a project', function () {
  let projectId: string
  let ownerToken: string
  let viewerToken: string

  before(function () {
    login(owner)
    createProject(projectName('Mcp')).then(id => {
      projectId = id
    })
    cy.then(() => shareProject(projectId, viewer, 'readOnly'))
    login(owner)
    createGitToken().then(token => {
      ownerToken = token
    })
    login(viewer)
    createGitToken().then(token => {
      viewerToken = token
    })
  })

  it('lists the tools of the project', function () {
    mcp(projectId, ownerToken, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '1.0.0' },
    })
      .its('body.result.serverInfo.name')
      .should('equal', 'overleaf')
    mcp(projectId, ownerToken, 'tools/list')
      .its('body.result.tools')
      .then((tools: { name: string }[]) => tools.map(tool => tool.name).sort())
      .should('deep.equal', [
        'compile',
        'get_clone_info',
        'get_compile_log',
        'get_output_file_link',
        'set_compiler',
      ])
  })

  it('refuses requests without a valid token', function () {
    mcp(projectId, null, 'tools/list').its('status').should('equal', 401)
    mcp(projectId, 'olp_not-a-real-token', 'tools/list')
      .its('status')
      .should('equal', 401)
  })

  it('refuses a token once it is deleted', function () {
    login(owner)
    createGitToken().then(token => {
      mcp(projectId, token, 'tools/list').its('status').should('equal', 200)
      cy.request('/oauth/personal-access-tokens').then(response => {
        const created = response.body.find(
          (t: { accessTokenPartial: string }) =>
            token.startsWith(t.accessTokenPartial)
        )
        requestWithCsrf('DELETE', `/oauth/personal-access-tokens/${created._id}`)
          .its('status')
          .should('be.lessThan', 400)
      })
      mcp(projectId, token, 'tools/list').its('status').should('equal', 401)
    })
  })

  it('refuses a user without access to the project', function () {
    login(stranger)
    createGitToken().then(token => {
      mcp(projectId, token, 'tools/list').its('status').should('equal', 403)
    })
  })

  it('only answers POST requests', function () {
    cy.request({
      url: `/project/${projectId}/mcp`,
      headers: { Authorization: `Bearer ${ownerToken}` },
      failOnStatusCode: false,
    })
      .its('status')
      .should('equal', 405)
  })

  it('tells how to clone the project, without the token', function () {
    callTool(projectId, ownerToken, 'get_clone_info').then(result => {
      const text = result.content[0].text
      expect(text).to.contain(`git clone http://sharelatex/git/${projectId}`)
      expect(text).not.to.contain(ownerToken)
    })
  })

  it('compiles what was pushed with git and reads the log', function () {
    const dir = workingCopy('mcp-push')
    gitClone(projectId, ownerToken, dir).its('exitCode').should('equal', 0)
    gitCommitAndPush(dir, 'main.tex', MAIN_TEX, 'Push main.tex')
      .its('exitCode')
      .should('equal', 0)

    compile(projectId, ownerToken).then(build => {
      expect(build.status).to.equal('success')
      expect(build.outputFiles).to.include.members(['output.pdf', 'output.log'])
      callTool(projectId, ownerToken, 'get_compile_log', {
        buildId: build.buildId,
        clsiServerId: build.clsiServerId,
      }).then(result => {
        expect(result.content[0].text).to.contain('Output written on output.pdf')
      })
    })
  })

  it('downloads the PDF through a link for this project only', function () {
    compile(projectId, ownerToken).then(build => {
      outputFileLink(projectId, ownerToken, build).then(link => {
        expect(link).to.match(
          new RegExp(`^http://sharelatex/project/${projectId}/mcp/download/`)
        )
        expect(link).not.to.contain(ownerToken)
        download(link).then(response => {
          expect(response.status).to.equal(200)
          expect(response.headers['content-disposition']).to.contain(
            'output.pdf'
          )
          expect(response.body.startsWith('%PDF')).to.equal(true)
        })
        download(link.slice(0, -2) + 'xx').its('status').should('equal', 404)
        download(link.replace(projectId, '0'.repeat(24)))
          .its('status')
          .should('equal', 404)
      })
      outputFileLink(projectId, ownerToken, build, 'output.log').then(link =>
        download(link).its('body').should('contain', 'Output written on')
      )
    })
  })

  it('lets a viewer compile and download but not change the compiler', function () {
    compile(projectId, viewerToken).then(build => {
      expect(build.status).to.equal('success')
      outputFileLink(projectId, viewerToken, build).then(link =>
        download(link).its('status').should('equal', 200)
      )
    })
    callTool(projectId, viewerToken, 'set_compiler', {
      compiler: 'xelatex',
    }).then(result => {
      expect(result.isError).to.equal(true)
      expect(result.content[0].text).to.contain('cannot change the settings')
    })
  })

  it('lets the owner change the compiler', function () {
    callTool(projectId, ownerToken, 'set_compiler', {
      compiler: 'xelatex',
    }).then(result => expect(result.isError).not.to.equal(true))
    compile(projectId, ownerToken).then(build => {
      callTool(projectId, ownerToken, 'get_compile_log', {
        buildId: build.buildId,
        clsiServerId: build.clsiServerId,
      }).then(result => expect(result.content[0].text).to.contain('XeTeX'))
    })
  })
})

describe('MCP server card in the editor', function () {
  it('shows how to connect AI clients to the project', function () {
    login(owner)
    createProject(projectName('Mcp card')).then(projectId => {
      openProject(projectId)
      cy.findByRole('tab', { name: 'Integrations' }).click()
      cy.findByText('Connect AI clients to this project.').click()
      cy.findByRole('dialog').within(() => {
        const url = `http://sharelatex/project/${projectId}/mcp`
        cy.contains('code', url)
        cy.contains('code', `claude mcp add --transport http overleaf`)
        for (const [tab, config] of [
          ['Codex', 'bearer_token_env_var = "OVERLEAF_TOKEN"'],
          ['Cursor', '"Bearer ${env:OVERLEAF_TOKEN}"'],
          ['VS Code', '"Bearer ${input:overleaf-token}"'],
          ['Gemini CLI', 'gemini mcp add --transport http'],
        ]) {
          cy.findByRole('tab', { name: tab }).click()
          cy.contains('code', config).should('be.visible')
        }
      })
    })
  })
})

describe('MCP access by role', function () {
  // read: compile and its output; write: project settings
  const roles = [
    { role: 'an invited editor', share: 'readAndWrite', link: false, write: true },
    { role: 'an editor through the link', share: 'readAndWrite', link: true, write: true },
    { role: 'a reviewer', share: 'review', link: false, write: false },
    { role: 'an invited viewer', share: 'readOnly', link: false, write: false },
    { role: 'a viewer through the link', share: 'readOnly', link: true, write: false },
  ] as const

  for (const { role, share, link, write } of roles) {
    it(`lets ${role} ${write ? 'read and write' : 'only read'}`, function () {
      const member = `member-${uuid()}@example.com`
      ensureUserExists(member)
      let projectId: string
      login(owner)
      createProject(projectName('Mcp role')).then(id => {
        projectId = id
      })
      cy.then(() =>
        link
          ? shareProjectByLink(projectId, member, share as 'readOnly' | 'readAndWrite')
          : shareProject(projectId, member, share)
      )
      login(member)
      createGitToken().then(token => {
        compile(projectId, token).then(build => {
          expect(build.status).to.equal('success')
          outputFileLink(projectId, token, build).then(link =>
            download(link).its('status').should('equal', 200)
          )
        })
        callTool(projectId, token, 'set_compiler', {
          compiler: 'lualatex',
        }).then(result =>
          expect(result.isError === true, result.content[0].text).to.equal(
            !write
          )
        )
      })
    })
  }
})

describe('MCP access after losing access to the project', function () {
  it('refuses the MCP server and the download links', function () {
    const member = `member-${uuid()}@example.com`
    ensureUserExists(member)
    let projectId: string
    login(owner)
    createProject(projectName('Mcp revoked')).then(id => {
      projectId = id
    })
    cy.then(() => shareProject(projectId, member, 'readOnly'))
    login(member)
    createGitToken().then(token => {
      compile(projectId, token).then(build => {
        outputFileLink(projectId, token, build).then(link => {
          download(link).its('status').should('equal', 200)

          login(owner)
          cy.request(`/project/${projectId}/members`)
            .its('body.members')
            .then((members: { _id: string; email: string }[]) => {
              const { _id } = members.find(m => m.email === member)!
              cy.visit(`/project/${projectId}`)
              requestWithCsrf('DELETE', `/project/${projectId}/users/${_id}`)
                .its('status')
                .should('be.lessThan', 400)
            })

          download(link).its('status').should('equal', 404)
          mcp(projectId, token, 'tools/list').its('status').should('equal', 403)
        })
      })
    })
  })
})
