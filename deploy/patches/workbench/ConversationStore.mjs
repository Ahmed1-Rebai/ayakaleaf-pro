// LambdaTeX addition: stores AI assistant conversations per user and project
// in MongoDB (collection `workbenchConversations`). The conversation id is the
// chat id the editor already generates; every query includes the owner's user
// id, so one user can never read, overwrite or delete another's conversation.
import {
  getCollectionInternal,
  ObjectId,
} from '../../../../app/src/infrastructure/mongodb.mjs'

const MAX_BYTES = 8 * 1024 * 1024 // below MongoDB's 16 MB document limit
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let collectionPromise = null
function collection() {
  collectionPromise ??= getCollectionInternal('workbenchConversations').then(
    async c => {
      await c.createIndex({ userId: 1, projectId: 1, updatedAt: -1 })
      return c
    }
  )
  return collectionPromise
}

export function isConversationId(id) {
  return typeof id === 'string' && ID.test(id)
}

/** First words of the first user message, without the editor's context block. */
export function titleFrom(messages) {
  for (const message of messages) {
    if (message?.role !== 'user') continue
    for (const part of message.parts || []) {
      if (part?.type !== 'text' || typeof part.text !== 'string') continue
      const text = part.text.split('--- START CONTEXT')[0].replace(/\s+/g, ' ').trim()
      if (text) return text.length > 60 ? text.slice(0, 57).trimEnd() + '…' : text
    }
  }
  return 'New conversation'
}

// Inline images make up most of a long conversation's size. If it gets too
// big, drop the oldest images (oldest first) and leave a short note in their place.
function compact(messages) {
  let size = JSON.stringify(messages).length
  if (size <= MAX_BYTES) return messages
  const copy = messages.map(m => ({ ...m, parts: [...(m.parts || [])] }))
  for (const message of copy) {
    for (let i = 0; i < message.parts.length && size > MAX_BYTES; i++) {
      const part = message.parts[i]
      if (part?.type === 'file' && typeof part.url === 'string') {
        size -= part.url.length
        message.parts[i] = { type: 'text', text: `[image ${part.filename || ''} not kept in history]` }
      }
    }
  }
  return copy
}

export async function saveConversation({ id, userId, projectId, messages }) {
  if (!isConversationId(id) || !Array.isArray(messages) || messages.length === 0) return
  const now = new Date()
  try {
    await (await collection()).updateOne(
      { _id: id, userId: new ObjectId(userId) },
      {
        $set: { projectId: new ObjectId(projectId), messages: compact(messages), updatedAt: now },
        $setOnInsert: { title: titleFrom(messages), createdAt: now },
      },
      { upsert: true }
    )
  } catch (err) {
    // E11000: the id belongs to another user's conversation; never overwrite it.
    if (err?.code !== 11000) throw err
  }
}

export async function listConversations({ userId, projectId }) {
  return (await collection())
    .aggregate([
      { $match: { userId: new ObjectId(userId), projectId: new ObjectId(projectId) } },
      { $sort: { updatedAt: -1 } },
      { $limit: 200 },
      {
        $project: {
          _id: 0,
          id: '$_id',
          title: 1,
          createdAt: 1,
          updatedAt: 1,
          messageCount: { $size: { $ifNull: ['$messages', []] } },
        },
      },
    ])
    .toArray()
}

export async function getConversation({ id, userId }) {
  const doc = await (await collection()).findOne({ _id: id, userId: new ObjectId(userId) })
  return doc && { id: doc._id, title: doc.title, projectId: String(doc.projectId), messages: doc.messages || [] }
}

export async function renameConversation({ id, userId, title }) {
  const clean = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!clean) return false
  const result = await (await collection()).updateOne(
    { _id: id, userId: new ObjectId(userId) },
    { $set: { title: clean } }
  )
  return result.matchedCount === 1
}

export async function deleteConversation({ id, userId }) {
  const result = await (await collection()).deleteOne({ _id: id, userId: new ObjectId(userId) })
  return result.deletedCount === 1
}
