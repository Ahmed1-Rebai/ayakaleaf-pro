// LambdaTeX addition: HTTP handlers for saved AI assistant conversations.
// Routes are registered in the patched WorkbenchRouter.mjs (login required);
// every handler only touches the logged-in user's own conversations and
// checks that the user can still read the project.
import { expressify } from '@overleaf/promise-utils'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import AuthorizationManager from '../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import {
  isConversationId,
  listConversations,
  getConversation,
  renameConversation,
  deleteConversation,
} from './ConversationStore.mjs'

const PROJECT_ID = /^[0-9a-f]{24}$/

async function canRead(userId, projectId) {
  return await AuthorizationManager.promises.canUserReadProject(userId, projectId, null)
}

async function list(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const projectId = String(req.query.project_id || '')
  if (!PROJECT_ID.test(projectId)) {
    return res.status(400).json({ error: 'invalid_project' })
  }
  if (!(await canRead(userId, projectId))) {
    return res.status(403).json({ error: 'forbidden' })
  }
  res.set('Cache-Control', 'no-store')
  res.json({ conversations: await listConversations({ userId, projectId }) })
}

async function get(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { conversationId } = req.params
  const conversation = isConversationId(conversationId)
    ? await getConversation({ id: conversationId, userId })
    : null
  if (!conversation) {
    return res.status(404).json({ error: 'not_found' })
  }
  if (!(await canRead(userId, conversation.projectId))) {
    return res.status(403).json({ error: 'forbidden' })
  }
  res.set('Cache-Control', 'no-store')
  res.json(conversation)
}

async function rename(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { conversationId } = req.params
  if (!isConversationId(conversationId)) {
    return res.status(404).json({ error: 'not_found' })
  }
  const renamed = await renameConversation({
    id: conversationId,
    userId,
    title: req.body?.title,
  })
  res.sendStatus(renamed ? 204 : 404)
}

async function remove(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { conversationId } = req.params
  if (!isConversationId(conversationId)) {
    return res.status(404).json({ error: 'not_found' })
  }
  res.sendStatus((await deleteConversation({ id: conversationId, userId })) ? 204 : 404)
}

export default {
  list: expressify(list),
  get: expressify(get),
  rename: expressify(rename),
  remove: expressify(remove),
}
