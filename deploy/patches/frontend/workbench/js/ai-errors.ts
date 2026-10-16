/**
 * LambdaTeX: what the AI assistant shows when something fails. Each failure
 * has a cause code (from the server, see app/src/AiErrors.mjs, or found here)
 * with its own title, text, and whether "Try again" makes sense.
 */

export type AiErrorCode =
  | 'offline'
  | 'session_expired'
  | 'ai_not_configured'
  | 'ai_access_denied'
  | 'gateway_unreachable'
  | 'gateway_error'
  | 'gateway_busy'
  | 'gateway_budget'
  | 'gateway_auth'
  | 'model_unavailable'
  | 'context_too_long'
  | 'images_unsupported'
  | 'invalid_attachments'
  | 'too_large'
  | 'invalid_request'
  | 'request_rejected'
  | 'tool_limit'
  | 'server_error'
  | 'unknown'

export type AiErrorInfo = {
  code: AiErrorCode | 'tool_failed'
  title: string
  message: string
  type: 'error' | 'warning'
  /** Show "Try again" (the same message is sent again). */
  retry: boolean
}

const ADMIN = 'If it keeps happening, tell the administrator.'

const TEXTS: Record<AiErrorCode, Omit<AiErrorInfo, 'code'>> = {
  offline: {
    title: "Can't reach LambdaTeX",
    message: 'Check your network connection, then try again.',
    type: 'error',
    retry: true,
  },
  session_expired: {
    title: 'Your session has expired',
    message: 'Reload the page and sign in again; your conversation is saved.',
    type: 'error',
    retry: false,
  },
  ai_not_configured: {
    title: "The AI assistant isn't set up",
    message: 'An administrator needs to configure the AI service for LambdaTeX.',
    type: 'error',
    retry: false,
  },
  ai_access_denied: {
    title: 'AI is turned off for your account',
    message: 'Ask an administrator to turn the AI features on for you.',
    type: 'error',
    retry: false,
  },
  gateway_unreachable: {
    title: "The AI service isn't responding",
    message: `LambdaTeX couldn't reach the AI service. Try again in a moment. ${ADMIN}`,
    type: 'error',
    retry: true,
  },
  gateway_error: {
    title: 'The AI service had a problem',
    message: `Its model server returned an error, so the reply stopped. Try again in a moment. ${ADMIN}`,
    type: 'error',
    retry: true,
  },
  gateway_busy: {
    title: 'The AI service is busy',
    message: 'It is receiving too many requests right now. Wait a minute, then try again.',
    type: 'warning',
    retry: true,
  },
  gateway_budget: {
    title: 'The AI budget is used up',
    message: "The lab's AI key has reached its spending limit. Tell the administrator.",
    type: 'error',
    retry: false,
  },
  gateway_auth: {
    title: "The AI service refused LambdaTeX's key",
    message: 'An administrator needs to check the AI key in the settings.',
    type: 'error',
    retry: false,
  },
  model_unavailable: {
    title: "The AI model isn't available",
    message: "The AI service doesn't have the configured model. An administrator needs to check the AI settings.",
    type: 'error',
    retry: false,
  },
  context_too_long: {
    title: 'This conversation is too long',
    message: 'The model can’t take in this much text. Start a new conversation, or ask about a smaller part of the document.',
    type: 'warning',
    retry: false,
  },
  images_unsupported: {
    title: "The model can't read images",
    message: 'Remove the image and try again, or ask the administrator to set up a model that reads images.',
    type: 'warning',
    retry: false,
  },
  invalid_attachments: {
    title: "This attachment can't be sent",
    message: 'Only images (PNG, JPEG, GIF or WebP) under 2 MB can be attached.',
    type: 'warning',
    retry: false,
  },
  too_large: {
    title: 'This message is too large',
    message: 'Send fewer or smaller images, or start a new conversation.',
    type: 'warning',
    retry: false,
  },
  invalid_request: {
    title: "This conversation can't be continued",
    message: 'Start a new conversation and ask again.',
    type: 'warning',
    retry: false,
  },
  request_rejected: {
    title: 'The AI service rejected the request',
    message: `Try rephrasing, or start a new conversation. ${ADMIN}`,
    type: 'error',
    retry: true,
  },
  tool_limit: {
    title: 'Step limit reached',
    message: 'The assistant used all its steps for this message. Send another message to let it continue.',
    type: 'warning',
    retry: false,
  },
  server_error: {
    title: 'LambdaTeX had a problem',
    message: `The reply couldn't be completed. Try again. ${ADMIN}`,
    type: 'error',
    retry: true,
  },
  unknown: {
    title: 'Something went wrong',
    message: "The reply couldn't be completed. Try again, or start a new conversation.",
    type: 'error',
    retry: true,
  },
}

const CODES = new Set(Object.keys(TEXTS))

/** A failed request to /workbench/tex-gpt, with its cause. */
export class AiRequestError extends Error {
  readonly code: AiErrorCode

  constructor(code: AiErrorCode) {
    super(`[${code}]`)
    this.name = 'AiRequestError'
    this.code = code
  }
}

/** Cause of an HTTP error from /workbench/tex-gpt (the JSON body names it when it can). */
export function codeForResponse(status: number, serverCode: string | undefined): AiErrorCode {
  if (serverCode && CODES.has(serverCode)) return serverCode as AiErrorCode
  if (serverCode === 'ai_tool_call_limit_exceeded') return 'tool_limit'
  if (serverCode === 'invalid_messages') return 'invalid_request'
  if (status === 401) return 'session_expired'
  if (status === 403) return serverCode ? 'ai_access_denied' : 'session_expired' // no JSON: CSRF/session check
  if (status === 409) return 'tool_limit'
  if (status === 413) return 'too_large'
  if (status === 400) return 'invalid_request'
  if (status >= 500) return 'server_error'
  return 'unknown'
}

/** What to show for any error the chat reports. */
export function describeAiError(err: unknown): AiErrorInfo {
  let code: AiErrorCode = 'unknown'
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const fromStream = /^\[([a-z_]+)\]/.exec(message)?.[1]
  if (err instanceof AiRequestError) {
    code = err.code
  } else if (fromStream && CODES.has(fromStream)) {
    code = fromStream as AiErrorCode
  } else if (err instanceof TypeError && /fetch|network|load failed/i.test(message)) {
    code = 'offline'
  }
  return { code, ...TEXTS[code] }
}

/** A tool the assistant ran in the browser failed (it is told and may try another way). */
export function describeToolError(toolTitle: string, err: unknown): AiErrorInfo {
  const detail = err instanceof Error && err.message ? err.message : 'it did not complete'
  return {
    code: 'tool_failed',
    title: "A step didn't work",
    message: `${toolTitle}: ${detail}`,
    type: 'warning',
    retry: false,
  }
}

/** True for errors that need no message (the user stopped the reply). */
export function isAbort(err: unknown) {
  const { name, message } = (err ?? {}) as { name?: string; message?: string }
  return name === 'AbortError' || /^\[aborted\]/.test(String(message ?? ''))
}
