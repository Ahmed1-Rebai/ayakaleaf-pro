// LambdaTeX addition: AI autocomplete for the LaTeX editor (grey "ghost" text).
//
// POST /workbench/autocomplete { projectId, path, prefix, suffix } -> { completion }
//
// Same gateway, model, AI access check, consent and token quota as the chat.
// The model's thinking is switched off (chat_template_kwargs), so a suggestion
// comes back in a fraction of a second; if the gateway rejects that option it is
// dropped for the rest of the process. AI_AUTOCOMPLETE=false turns the endpoint
// off; AI_AUTOCOMPLETE_MODEL picks another model on the same gateway.
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { expressify } from '@overleaf/promise-utils'
import { generateText } from 'ai'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import AuthorizationManager from '../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import Errors from '../../../../app/src/Features/Errors/Errors.js'
import { getProvider } from './WorkbenchAiClient.mjs'
import { isQuotaEnabled, getRemainingTokens, recordTokenUsage } from './TokenQuota.mjs'

const ENABLED = !/^(false|0|off|no)$/i.test(process.env.AI_AUTOCOMPLETE || '')
const PROJECT_ID = /^[0-9a-f]{24}$/
const CONSENT_TUTORIAL = 'workbench-consent-release' // set when the user accepts the AI terms
const MAX_PREFIX = 6000
const MAX_SUFFIX = 2000
const MAX_LENGTH = 160
let thinkingSwitch = true

const SYSTEM = `You are the inline autocomplete of a LaTeX editor. The user is typing; ‸ marks the cursor.
Reply with exactly the text to insert at ‸ — nothing else: no explanation, no quotes, no code fences, no text that is already before or after ‸.
- Continue naturally: finish the current word, LaTeX command, argument or sentence. One line at most, ideally under 15 words.
- Spacing is copied verbatim: if ‸ follows a complete word and you start a new word, begin with a space; if ‸ is inside a word, continue the word directly.
- If ‸ follows the end of a sentence, start the next sentence (with a space); never continue a finished sentence with a comma.
- Match the language, notation and style of the document. Close braces, brackets or $ only if the text after ‸ does not already close them.
- If nothing useful fits, reply with an empty message.`

function model() {
  return process.env.AI_AUTOCOMPLETE_MODEL || Settings.workbenchAi?.model
}

// Removes the part of the suggestion that the text after the cursor already has,
// e.g. a "}" the editor closed automatically.
function trimSuffixOverlap(text, suffix) {
  const line = suffix.split('\n')[0]
  for (let k = Math.min(text.length, line.length, 40); k >= 1; k--) {
    const overlap = line.slice(0, k)
    if (text.endsWith(overlap) && (k >= 4 || /^[\]})$]+$/.test(overlap))) {
      return text.slice(0, -k)
    }
  }
  return text
}

/** Turns the model's reply into text that can be inserted at the cursor, or ''. */
export function cleanCompletion(raw, prefix, suffix) {
  let text = String(raw || '')
    .replace(/\r/g, '')
    .replace(/‸/g, '')
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```\s*$/, '')
  if (text.startsWith('\n')) return '' // shown inline: the suggestion must start on this line
  text = text.split('\n')[0]
  if (/\s$/.test(prefix)) text = text.replace(/^[ \t]+/, '')
  const core = text.trim()
  if (!core) return ''
  if (core.length >= 12 && prefix.slice(-400).includes(core)) return '' // repeats earlier text
  if (/[.!?]\s*$/.test(prefix) && /^[,;:.]/.test(core)) return ''
  text = trimSuffixOverlap(text, suffix)
  if (text.length > MAX_LENGTH) {
    const cut = text.lastIndexOf(' ', MAX_LENGTH)
    text = text.slice(0, cut > 40 ? cut : MAX_LENGTH)
  }
  return text.trimEnd()
}

async function hasConsent(userId) {
  const user = await UserGetter.promises.getUser(userId, { completedTutorials: 1 })
  return Boolean(user?.completedTutorials?.[CONSENT_TUTORIAL])
}

async function complete(req, res) {
  res.set('Cache-Control', 'no-store')
  if (!ENABLED) return res.status(404).json({ error: 'autocomplete_disabled' })
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { projectId, path, prefix, suffix } = req.body || {}
  if (
    !PROJECT_ID.test(String(projectId || '')) ||
    typeof prefix !== 'string' ||
    (suffix != null && typeof suffix !== 'string') ||
    (path != null && typeof path !== 'string')
  ) {
    return res.status(400).json({ error: 'invalid_request' })
  }
  if (!(await hasConsent(userId))) {
    return res.status(403).json({ error: 'ai_consent_required' })
  }
  let canWrite
  try {
    canWrite = await AuthorizationManager.promises.canUserWriteProjectContent(userId, projectId, null)
  } catch (err) {
    if (err instanceof Errors.NotFoundError) return res.status(404).json({ error: 'not_found' })
    throw err
  }
  if (!canWrite) return res.status(403).json({ error: 'forbidden' })
  if (isQuotaEnabled()) {
    try {
      if ((await getRemainingTokens(userId)) <= 0) {
        return res.status(429).json({ error: 'token_quota_exceeded' })
      }
    } catch (err) {
      logger.warn({ err, userId }, 'autocomplete quota check failed, allowing')
    }
  }

  const before = prefix.slice(-MAX_PREFIX)
  const after = (suffix || '').slice(0, MAX_SUFFIX)
  const file = (path || 'main.tex').slice(0, 300)
  // Stop when the user moves on (the editor aborts its request) or after 8s.
  const aborter = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) aborter.abort()
  })
  const request = withThinkingSwitch => ({
    model: getProvider()(model()),
    system: SYSTEM,
    prompt: `File: ${file}\n\n${before}‸${after}`,
    maxOutputTokens: 48,
    temperature: 0.2,
    maxRetries: 0,
    abortSignal: AbortSignal.any([aborter.signal, AbortSignal.timeout(8000)]),
    ...(withThinkingSwitch && {
      providerOptions: {
        'overleaf-workbench': { chat_template_kwargs: { enable_thinking: false } },
      },
    }),
  })

  let result
  try {
    try {
      result = await generateText(request(thinkingSwitch))
    } catch (err) {
      if (!thinkingSwitch || !/chat_template_kwargs|enable_thinking/i.test(String(err?.responseBody || err?.message))) {
        throw err
      }
      thinkingSwitch = false
      logger.info('autocomplete: the gateway rejects chat_template_kwargs; sending requests without it')
      result = await generateText(request(false))
    }
  } catch (err) {
    if (aborter.signal.aborted) return
    logger.warn({ err: { message: err?.message, status: err?.statusCode }, userId }, 'autocomplete request failed')
    return res.status(502).json({ error: 'ai_error' })
  }

  if (isQuotaEnabled() && result.usage?.totalTokens) {
    recordTokenUsage(userId, result.usage.totalTokens).catch(err =>
      logger.warn({ err, userId }, 'autocomplete token usage not recorded')
    )
  }
  res.json({ completion: cleanCompletion(result.text, before, after) })
}

export default { complete: expressify(complete) }
