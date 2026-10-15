/**
 * LambdaTeX: saved AI conversations for the current project.
 * Lists, opens, renames and deletes conversations stored by the server
 * (/workbench/conversations). Shown over the chat, which stays mounted.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import classNames from 'classnames'
import { getJSON, postJSON, deleteJSON } from '@/infrastructure/fetch-json'
import OLButton from '@/shared/components/ol/ol-button'
import OLIconButton from '@/shared/components/ol/ol-icon-button'
import MaterialIcon from '@/shared/components/material-icon'
import { debugConsole } from '@/utils/debugging'

type ConversationSummary = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

function relativeTime(iso: string) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days} d ago`
  return new Date(iso).toLocaleDateString()
}

export default function ConversationList({
  projectId,
  activeId,
  onOpen,
  onNew,
  onDeleted,
}: {
  projectId: string
  activeId: string
  onOpen: (id: string) => void
  onNew: () => void
  onDeleted: (id: string) => void
}) {
  const [items, setItems] = useState<ConversationSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const renamingRef = useRef<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await getJSON(`/workbench/conversations?project_id=${projectId}`)
      setItems(data.conversations)
      setError(null)
    } catch (err) {
      debugConsole.error(err)
      setError('Conversations could not be loaded.')
    }
  }, [projectId])

  useEffect(() => {
    load()
  }, [load])

  const startRename = (conversation: ConversationSummary) => {
    setConfirming(null)
    setDraft(conversation.title)
    setRenaming(conversation.id)
    renamingRef.current = conversation.id
  }

  // Enter and blur both end editing; only the first one saves.
  const finishRename = async (id: string, save: boolean) => {
    if (renamingRef.current !== id) return
    renamingRef.current = null
    setRenaming(null)
    const title = draft.replace(/\s+/g, ' ').trim()
    const current = items?.find(c => c.id === id)
    if (!save || !title || title === current?.title) return
    setItems(list => list?.map(c => (c.id === id ? { ...c, title } : c)) ?? null)
    try {
      await postJSON(`/workbench/conversations/${id}/rename`, { body: { title } })
    } catch (err) {
      debugConsole.error(err)
      setError('The conversation could not be renamed.')
      load()
    }
  }

  const remove = async (id: string) => {
    setBusy(id)
    try {
      await deleteJSON(`/workbench/conversations/${id}`)
      setItems(list => list?.filter(c => c.id !== id) ?? null)
      onDeleted(id)
    } catch (err) {
      debugConsole.error(err)
      setError('The conversation could not be deleted.')
    } finally {
      setBusy(null)
      setConfirming(null)
    }
  }

  return (
    <div className="workbench-conversations" role="region" aria-label="Conversations">
      <div className="workbench-conversations-header">
        <span className="workbench-conversations-title">Conversations</span>
        <OLButton size="sm" variant="primary" onClick={onNew}>
          <MaterialIcon type="add" /> New conversation
        </OLButton>
      </div>
      {error && <div className="workbench-conversations-note text-danger">{error}</div>}
      {items === null && !error && (
        <div className="workbench-conversations-note">Loading conversations…</div>
      )}
      {items?.length === 0 && (
        <div className="workbench-conversations-note">
          No saved conversations yet. A conversation is saved after the assistant's first reply.
        </div>
      )}
      <ul className="workbench-conversations-list">
        {items?.map(conversation => (
          <li
            key={conversation.id}
            className={classNames('workbench-conversation', {
              active: conversation.id === activeId,
            })}
          >
            {renaming === conversation.id ? (
              <input
                autoFocus
                className="form-control form-control-sm workbench-conversation-rename"
                value={draft}
                maxLength={120}
                aria-label="Conversation name"
                onChange={event => setDraft(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') finishRename(conversation.id, true)
                  if (event.key === 'Escape') finishRename(conversation.id, false)
                }}
                onBlur={() => finishRename(conversation.id, true)}
              />
            ) : confirming === conversation.id ? (
              <div className="workbench-conversation-confirm" role="alert">
                <span>Delete this conversation?</span>
                <span className="workbench-conversation-confirm-actions">
                  <OLButton
                    size="sm"
                    variant="danger"
                    disabled={busy === conversation.id}
                    onClick={() => remove(conversation.id)}
                  >
                    Delete
                  </OLButton>
                  <OLButton size="sm" variant="secondary" onClick={() => setConfirming(null)}>
                    Cancel
                  </OLButton>
                </span>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="workbench-conversation-open"
                  onClick={() => onOpen(conversation.id)}
                  title={conversation.title}
                  aria-current={conversation.id === activeId ? 'true' : undefined}
                >
                  <span className="workbench-conversation-name">{conversation.title}</span>
                  <span className="workbench-conversation-meta">
                    {relativeTime(conversation.updatedAt)} · {conversation.messageCount}{' '}
                    {conversation.messageCount === 1 ? 'message' : 'messages'}
                  </span>
                </button>
                <OLIconButton
                  size="sm"
                  variant="ghost"
                  icon="edit"
                  accessibilityLabel="Rename conversation"
                  onClick={() => startRename(conversation)}
                />
                <OLIconButton
                  size="sm"
                  variant="ghost"
                  icon="delete"
                  accessibilityLabel="Delete conversation"
                  onClick={() => {
                    setRenaming(null)
                    setConfirming(conversation.id)
                  }}
                />
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
