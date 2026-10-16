// LambdaTeX addition: sorts AI failures into a few causes with a stable code,
// so the chat can say what happened and what to do (texts in the frontend's
// js/ai-errors.ts), and the log says why. Pure functions (no Overleaf imports);
// unit-tested by deploy/tests/ai_errors_test.mjs.

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])

function unwrap(err) {
  // The AI SDK wraps the last attempt in a RetryError.
  let current = err
  for (let i = 0; i < 3 && current; i++) {
    if (current.name === 'AI_RetryError' && current.lastError) current = current.lastError
    else break
  }
  return current
}

function networkCode(err) {
  for (let e = err, i = 0; e && i < 4; e = e.cause, i++) {
    if (typeof e.code === 'string' && NETWORK_CODES.has(e.code)) return e.code
  }
  return null
}

/**
 * Returns { code, status, detail }:
 *   code    one of: aborted, gateway_unreachable, gateway_auth, gateway_busy,
 *           gateway_budget, gateway_error, model_unavailable, context_too_long,
 *           images_unsupported, request_rejected, unknown
 *   status  HTTP status from the AI gateway, if any
 *   detail  a short, single-line description for the log (never sent to users)
 *   repeat  true when the error is our own stream text coming back (already logged)
 */
export function classifyAiError(error) {
  const err = unwrap(error) ?? {}
  const status = Number(err.statusCode ?? err.status ?? err.response?.status) || null
  const body = typeof err.responseBody === 'string' ? err.responseBody : ''
  const text = `${err.message ?? ''} ${body}`.toLowerCase()
  const detail = `${err.name ?? 'Error'}: ${err.message ?? ''} ${body}`.replace(/\s+/g, ' ').trim().slice(0, 240)
  const result = code => ({ code, status, detail, repeat: false })

  // The SDK hands our own "[code] ..." stream text back once more.
  const own = /^\[([a-z_]+)\]/.exec(String(err.message ?? ''))
  if (own) return { code: own[1], status, detail, repeat: true }

  if (err.name === 'AbortError' || err.name === 'ResponseAborted' || /aborted|operation was aborted/.test(text) && !status) {
    return result('aborted')
  }
  if (!status && (networkCode(err) || /fetch failed|socket hang up|network error|connect timeout|timed out/.test(text))) {
    return result('gateway_unreachable')
  }
  if (/budget|insufficient_quota|exceeded your current quota|billing|out of credits/.test(text)) {
    return result('gateway_budget')
  }
  if (/context length|context_length|maximum context|context window|too many tokens|prompt is too long|input is too long|reduce the length|max_model_len/.test(text)) {
    return result('context_too_long')
  }
  if ((status === 400 || status === 422 || !status) && /image_url|image input|images? (are|is) not supported|vision|multimodal|content must be a string|does not support image/.test(text)) {
    return result('images_unsupported')
  }
  if (status === 401 || status === 403 || /invalid api key|incorrect api key|authentication/.test(text) && status && status < 500) {
    return result('gateway_auth')
  }
  if (status === 404 || /model .{0,40}(not found|does not exist)|no such model|invalid model|unknown model/.test(text)) {
    return result('model_unavailable')
  }
  if (status === 429) return result('gateway_busy')
  if (status === 408 || status === 504) return result('gateway_unreachable')
  if (status && status >= 500) return result('gateway_error')
  if (status && status >= 400) return result('request_rejected')
  return result('unknown')
}

/** Text sent in the reply stream: "[code]" first, so the chat can show its own message. */
export function streamErrorText(code) {
  return `[${code}] The AI reply could not be completed (${code.replace(/_/g, ' ')}).`
}
