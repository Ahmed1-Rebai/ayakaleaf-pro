// LambdaTeX addition: picks the TeX engine for every compile (Recompile,
// auto-compile and the AI assistant's compile tool). Called from the patched
// CompileManager.mjs:
//   beforeCompile()      switches to the engine the project's files need
//                        (magic comment, packages, commands; CompilerDetection.mjs);
//   retryWithLogEngine() after a compile that produced no PDF, switches to the
//                        engine its log asks for and compiles once more.
// A switch is saved as the project's compiler when the user may change the
// settings, and pushed to open editors so the Compiler menu shows it.
// AUTO_COMPILER=false turns this off.
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'
import ProjectOptionsHandler from '../Project/ProjectOptionsHandler.mjs'
import DocumentUpdaterHandler from '../DocumentUpdater/DocumentUpdaterHandler.mjs'
import EditorRealTimeController from '../Editor/EditorRealTimeController.mjs'
import AuthorizationManager from '../Authorization/AuthorizationManager.mjs'
import ClsiManager from './ClsiManager.mjs'
import { ENGINES, detectCompiler, engineFromLog } from './CompilerDetection.mjs'

const ENABLED = !/^(false|0|off|no)$/i.test(process.env.AUTO_COMPILER || '')
const MAX_LOG_BYTES = 4 * 1024 * 1024

function currentCompiler(project) {
  return ENGINES.includes(project.compiler)
    ? project.compiler
    : Settings.defaultLatexCompiler || 'pdflatex'
}

// Uses the engine for this compile; saves it if the user may change settings.
async function switchCompiler(projectId, userId, project, compiler) {
  project.compiler = compiler
  if (!userId) return false
  const mayChange =
    await AuthorizationManager.promises.canUserWriteProjectSettings(
      userId,
      projectId,
      null
    )
  if (!mayChange) return false
  await ProjectOptionsHandler.promises.setCompiler(projectId, compiler)
  EditorRealTimeController.emitToRoom(projectId, 'compilerUpdated', compiler)
  return true
}

async function beforeCompile(projectId, userId, project, options) {
  if (!ENABLED || !project?.rootFolder || !options.rootResourcePath) return null
  try {
    const docIds = new Map()
    const docPaths = ProjectEntityHandler.getAllDocPathsFromProject(project)
    for (const [docId, path] of Object.entries(docPaths)) {
      docIds.set(path.replace(/^\//, ''), docId)
    }
    const decision = await detectCompiler({
      rootPath: options.rootResourcePath,
      current: currentCompiler(project),
      has: path => docIds.has(path),
      read: async path => {
        const docId = docIds.get(path)
        if (!docId) return null
        const { lines } = await DocumentUpdaterHandler.promises.getDocument(
          projectId,
          docId,
          -1
        )
        return Array.isArray(lines) ? lines.join('\n') : null
      },
    })
    if (decision?.changed) {
      const from = currentCompiler(project)
      const saved = await switchCompiler(projectId, userId, project, decision.compiler)
      logger.info(
        { projectId, from, to: decision.compiler, reason: decision.reason, saved },
        'compiler chosen automatically'
      )
    }
    return decision
  } catch (err) {
    logger.warn(
      { err, projectId },
      'automatic compiler selection failed; using the project setting'
    )
    return null
  }
}

async function readLog(projectId, compileAsUser, clsiServerId, buildId) {
  const stream = await ClsiManager.promises.getOutputFileStream(
    projectId,
    compileAsUser,
    clsiServerId,
    buildId,
    'output.log'
  )
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk))
    size += chunk.length
    if (size >= MAX_LOG_BYTES) break
  }
  stream.destroy?.()
  return Buffer.concat(chunks).toString('utf8')
}

async function retryWithLogEngine({
  projectId,
  userId,
  compileAsUser,
  project,
  result,
  compileAgain,
}) {
  if (!ENABLED || result?.status !== 'failure') return result
  try {
    if (!result.outputFiles?.some(file => file.path === 'output.log')) {
      return result
    }
    const log = await readLog(
      projectId,
      compileAsUser,
      result.clsiServerId,
      result.buildId
    )
    const from = currentCompiler(project)
    const engine = engineFromLog(log, from)
    if (!engine) return result
    const saved = await switchCompiler(projectId, userId, project, engine.compiler)
    logger.info(
      { projectId, from, to: engine.compiler, reason: engine.reason, saved },
      'compile needs another engine; compiling again'
    )
    return await compileAgain()
  } catch (err) {
    logger.warn({ err, projectId }, 'engine retry failed')
    return result
  }
}

export default { beforeCompile, retryWithLogEngine }
