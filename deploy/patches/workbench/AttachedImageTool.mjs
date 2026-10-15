// LambdaTeX addition: lets the AI assistant save an image the user attached in
// the chat into the project, so the document can include it with
// \includegraphics. Without this, the model sees the picture but there is no
// project file, and the compile fails with "File ... not found".
//
// Defined as a dynamic tool: the chat client skips dynamic tool calls instead
// of answering them with "Unknown tool", and the server runs it.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import Path from 'node:path'
import { dynamicTool, jsonSchema } from 'ai'
import logger from '@overleaf/logger'
import EditorController from '../../../../app/src/Features/Editor/EditorController.mjs'
import AuthorizationManager from '../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import ProjectLocator from '../../../../app/src/Features/Project/ProjectLocator.mjs'
import Errors from '../../../../app/src/Features/Errors/Errors.js'

// Formats pdfLaTeX can include.
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png' }
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/

/** Image parts the user attached, in conversation order. */
export function attachedImages(messages) {
  const images = []
  for (const message of messages) {
    if (message?.role !== 'user' || !Array.isArray(message.parts)) continue
    for (const part of message.parts) {
      if (
        part?.type === 'file' &&
        typeof part.mediaType === 'string' &&
        part.mediaType.startsWith('image/') &&
        typeof part.url === 'string'
      ) {
        images.push(part)
      }
    }
  }
  return images
}

/** The chat runs inside the editor, so the request's Referer names the project. */
export function projectIdFromReferer(req) {
  const match = /\/project\/([0-9a-f]{24})(?:[/?#]|$)/.exec(req.get('referer') || '')
  return match ? match[1] : null
}

function targetPath(requested, hash, ext) {
  let target = (requested || `images/chat-image-${hash}`).trim().replace(/^\/+/, '')
  // The extension must match the real format, or LaTeX can't read the file.
  target = target.replace(/\.(png|jpe?g)$/i, '') + `.${ext}`
  return SAFE_PATH.test(target) && !target.includes('..') ? target : null
}

async function findInProject(projectId, path) {
  try {
    const { element, type } = await ProjectLocator.promises.findElementByPath({
      project_id: projectId,
      path: `/${path}`,
      exactCaseMatch: true,
    })
    return { type, hash: element.hash }
  } catch (err) {
    if (err instanceof Errors.NotFoundError) return null
    throw err
  }
}

// The tool runs without the user's approval, so it never replaces a project
// file: the same image is reused, a different file keeps its name and the new
// image gets the next free one (photo-2.jpg, ...).
async function freePath(projectId, target, ext, data) {
  const blobHash = crypto
    .createHash('sha1')
    .update(`blob ${data.length}\0`)
    .update(data)
    .digest('hex')
  const base = target.slice(0, -(ext.length + 1))
  for (let n = 1; n <= 50; n++) {
    const candidate = n === 1 ? target : `${base}-${n}.${ext}`
    const existing = await findInProject(projectId, candidate)
    if (!existing) return { path: candidate, exists: false }
    if (existing.type === 'file' && existing.hash === blobHash) {
      return { path: candidate, exists: true }
    }
  }
  return null
}

export function createSaveAttachedImageTool({ images, projectId, userId }) {
  return dynamicTool({
    description:
      'Save an image the user attached in this chat into the project, so the ' +
      'document can include it with \\includegraphics. Call it before referencing ' +
      'the image, then use the returned path. Never replaces an existing file: if the ' +
      'name is taken, the image is saved under a new name, which is returned. ' +
      'Returns { saved, path, note? } or { saved: false, error }.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        index: {
          type: 'integer',
          minimum: 1,
          description: 'Which attached image: 1 is the first image attached in this conversation.',
        },
        path: {
          type: 'string',
          description:
            'Optional project path without spaces, e.g. "images/photo.jpg". ' +
            'Defaults to images/chat-image-<id>.<ext>.',
        },
      },
      required: ['index'],
      additionalProperties: false,
    }),
    async execute(input) {
      const { index, path } = input || {}
      const image = images[(Number(index) || 0) - 1]
      if (!image) {
        return { saved: false, error: `There is no attached image ${index}; ${images.length} attached.` }
      }
      const ext = EXTENSIONS[image.mediaType.toLowerCase()]
      if (!ext) {
        return {
          saved: false,
          error: `${image.mediaType} images can't be used by pdfLaTeX. Ask the user for a PNG or JPEG.`,
        }
      }
      const prefix = `data:${image.mediaType};base64,`
      if (!image.url.startsWith(prefix)) {
        return { saved: false, error: 'The attachment is not an inline image.' }
      }
      const data = Buffer.from(image.url.slice(prefix.length), 'base64')
      const hash = crypto.createHash('sha256').update(data).digest('hex').slice(0, 10)
      const target = targetPath(path, hash, ext)
      if (!target) {
        return {
          saved: false,
          error: 'Use a path made of letters, digits, ".", "-", "_" and "/", e.g. images/photo.jpg.',
        }
      }
      const canWrite = await AuthorizationManager.promises.canUserWriteProjectContent(
        userId,
        projectId,
        null
      )
      if (!canWrite) {
        return { saved: false, error: 'The user cannot edit this project.' }
      }
      const free = await freePath(projectId, target, ext, data)
      if (!free) {
        return { saved: false, error: `Too many files are named like ${target}; choose another path.` }
      }
      if (free.exists) {
        return { saved: true, path: free.path, note: 'This image is already in the project; nothing was written.' }
      }
      const tmp = Path.join(os.tmpdir(), `lambdatex-${crypto.randomUUID()}.${ext}`)
      try {
        await fs.writeFile(tmp, data)
        await EditorController.promises.upsertFileWithPath(
          projectId,
          `/${free.path}`,
          tmp,
          null,
          'upload',
          userId
        )
      } catch (err) {
        logger.warn({ err, projectId, userId }, 'save_attached_image failed')
        return { saved: false, error: 'The image could not be saved to the project.' }
      } finally {
        await fs.rm(tmp, { force: true })
      }
      return free.path === target
        ? { saved: true, path: target }
        : {
            saved: true,
            path: free.path,
            note: `${target} already exists and was left unchanged; the image was saved as ${free.path}.`,
          }
    },
  })
}
