import Path from 'path'
import { pipeline } from 'stream/promises'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { expressify } from '@overleaf/promise-utils'
import { fetchJson } from '@overleaf/fetch-utils'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z, zz } from '../../../../app/src/infrastructure/Validation.mjs'
import JsonWebToken from '../../../../app/src/infrastructure/JsonWebToken.mjs'
import AuthorizationManager from '../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import CompileManager from '../../../../app/src/Features/Compile/CompileManager.mjs'
import ClsiManager from '../../../../app/src/Features/Compile/ClsiManager.mjs'
import EditorController from '../../../../app/src/Features/Editor/EditorController.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import Errors from '../../../../app/src/Features/Errors/Errors.js'

const DOWNLOAD_AUDIENCE = 'mcp-download'
const DOWNLOAD_LINK_TTL = '5m'

const buildId = zz.buildId().describe('buildId returned by compile.')
const clsiServerId = zz
  .clsiServerId()
  .optional()
  .describe('clsiServerId returned by compile, when it returned one.')

function text(value) {
  return {
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  }
}

// Compile output lives in per-user folders, as CompileManager.compile uses
function compileUserId(userId) {
  return Settings.disablePerUserCompiles ? null : userId
}

// The router checked that the user can read the project
function createServer(userId, projectId) {
  const server = new McpServer({ name: 'overleaf', version: '1.0.0' })

  server.registerTool(
    'get_clone_info',
    {
      description:
        'How to clone this project with git. Read and edit its files in the ' +
        'clone, then commit and push them; pull first when the push is ' +
        'rejected because the project changed.',
    },
    async () => {
      return text(
        `git clone ${Settings.siteUrl}/git/${projectId}\n\n` +
          'Git asks for a username and password: the username is "git" and ' +
          'the password is an Overleaf Git authentication token, which the ' +
          'user stores in their git credential helper. Never ask the user ' +
          'to share the token.'
      )
    }
  )

  server.registerTool(
    'compile',
    {
      description:
        'Compile the project as it is on Overleaf: push your git commits ' +
        'first. Returns the status, the buildId and clsiServerId for ' +
        'get_compile_log and get_output_file_link, and the output files.',
    },
    async () => {
      const { status, outputFiles, buildId, clsiServerId } =
        await CompileManager.promises.compile(projectId, userId, {})
      return text({
        status,
        buildId,
        clsiServerId,
        outputFiles: outputFiles.map(file => file.path),
      })
    }
  )

  server.registerTool(
    'get_compile_log',
    {
      description: 'Read the LaTeX log (output.log) of a compile.',
      inputSchema: { buildId, clsiServerId },
    },
    async ({ buildId, clsiServerId }) => {
      const stream = await ClsiManager.promises.getOutputFileStream(
        projectId,
        compileUserId(userId),
        clsiServerId,
        buildId,
        'output.log'
      )
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      return text(Buffer.concat(chunks).toString('utf8'))
    }
  )

  server.registerTool(
    'get_output_file_link',
    {
      description:
        'Get a download link for an output file of a compile, output.pdf by ' +
        'default. The link expires after 5 minutes, e.g. download it with ' +
        'curl -o output.pdf "<link>".',
      inputSchema: {
        buildId,
        clsiServerId,
        file: zz
          .filepath()
          .default('output.pdf')
          .describe('Output file name, as listed by compile.'),
      },
    },
    async ({ buildId, clsiServerId, file }) => {
      const token = await JsonWebToken.promises.sign(
        { projectId, userId, buildId, clsiServerId, file },
        { audience: DOWNLOAD_AUDIENCE, expiresIn: DOWNLOAD_LINK_TTL }
      )
      return text(`${Settings.siteUrl}/project/${projectId}/mcp/download/${token}`)
    }
  )

  server.registerTool(
    'get_settings',
    {
      description:
        'Read the project settings: compiler, TeX Live image, main ' +
        'document, main bibliography and spell check language, and the ' +
        'TeX Live images this Overleaf offers.',
    },
    async () => {
      const project = await ProjectGetter.promises.getProject(projectId, {
        compiler: 1,
        imageName: 1,
        rootDoc_id: 1,
        mainBibliographyDoc_id: 1,
        spellCheckLanguage: 1,
        rootFolder: 1,
      })
      const { docs } = ProjectEntityHandler.getAllEntitiesFromProject(project)
      // paths as in the git clone, without the leading /
      const docPath = docId =>
        docs.find(({ doc }) => docId?.equals(doc._id))?.path.slice(1) ?? null
      return text({
        compiler: project.compiler,
        texLiveImage: project.imageName ?? null,
        mainDocument: docPath(project.rootDoc_id),
        mainBibliography: docPath(project.mainBibliographyDoc_id),
        spellCheckLanguage: project.spellCheckLanguage,
        availableTexLiveImages: (Settings.allowedImageNames || []).map(
          ({ imageName, imageDesc }) => ({ imageName, imageDesc })
        ),
      })
    }
  )

  server.registerTool(
    'word_count',
    {
      description:
        'Count the words of the main document, or of another .tex file, ' +
        'with texcount. Compile first.',
      inputSchema: {
        file: zz
          .filepath()
          .optional()
          .describe('A .tex file of the project, the main document by default.'),
        clsiServerId,
      },
    },
    async ({ file, clsiServerId }) => {
      const { texcount } = await CompileManager.promises.wordCount(
        projectId,
        compileUserId(userId),
        file || false,
        clsiServerId
      )
      return text(texcount)
    }
  )

  server.registerTool(
    'list_versions',
    {
      description:
        'List the versions saved in the project history, with their comment.',
    },
    async () => {
      const labels = await fetchJson(
        `${Settings.apis.project_history.url}/project/${projectId}/labels`
      )
      return text(
        labels.map(({ version, comment, created_at: createdAt }) => ({
          version,
          comment,
          createdAt,
        }))
      )
    }
  )

  server.registerTool(
    'set_compiler',
    {
      description: 'Set the LaTeX compiler used to build the project.',
      inputSchema: {
        compiler: z.enum(['pdflatex', 'xelatex', 'lualatex', 'latex']),
      },
    },
    async ({ compiler }) => {
      if (
        !(await AuthorizationManager.promises.canUserWriteProjectSettings(
          userId,
          projectId
        ))
      ) {
        throw new Error('You cannot change the settings of this project')
      }
      await EditorController.promises.setCompiler(projectId, compiler)
      return text(`The compiler is now ${compiler}.`)
    }
  )

  return server
}

async function handleRequest(req, res) {
  const server = createServer(
    req.oauth_user._id.toString(),
    req.params.project_id
  )
  // Stateless: a new server and transport for every request
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  res.on('close', () => {
    transport.close()
    server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
}

function methodNotAllowed(req, res) {
  res.set('Allow', 'POST').status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  })
}

async function downloadOutputFile(req, res) {
  let link
  try {
    link = JsonWebToken.getDecoded(req.params.token)
  } catch (err) {
    return res.sendStatus(404)
  }
  const { projectId, userId, buildId, clsiServerId, file } = link
  if (link.aud !== DOWNLOAD_AUDIENCE || projectId !== req.params.project_id) {
    return res.sendStatus(404)
  }
  // the user may have lost access since the link was made
  if (!(await AuthorizationManager.promises.canUserReadProject(userId, projectId))) {
    return res.sendStatus(404)
  }

  let stream
  try {
    stream = await ClsiManager.promises.getOutputFileStream(
      projectId,
      compileUserId(userId),
      clsiServerId,
      buildId,
      file
    )
  } catch (err) {
    if (err instanceof Errors.OutputFileFetchFailedError) {
      logger.debug({ err, projectId, buildId, file }, 'MCP output file not found')
      return res.sendStatus(404)
    }
    throw err
  }
  res.attachment(Path.basename(file))
  await pipeline(stream, res)
}

export default {
  handleRequest: expressify(handleRequest),
  methodNotAllowed,
  downloadOutputFile: expressify(downloadOutputFile),
}
