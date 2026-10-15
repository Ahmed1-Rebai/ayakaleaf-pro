// LambdaTeX addition: AI autocomplete for the LaTeX editor (grey "ghost" text).
//
// POST /workbench/autocomplete { projectId, path, prefix, suffix, corrections? }
//   -> { completion, fixes: [{ from, to, text, wrong }] } (offsets relative to the cursor)
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
import { cleanCompletion, parseCorrectionReply, placeFixes } from './AutocompleteText.mjs'

const ENABLED = !/^(false|0|off|no)$/i.test(process.env.AI_AUTOCOMPLETE || '')
const PROJECT_ID = /^[0-9a-f]{24}$/
const CONSENT_TUTORIAL = 'workbench-consent-release' // set when the user accepts the AI terms
const MAX_PREFIX = 6000
const MAX_SUFFIX = 2000
let thinkingSwitch = true

// Suggestions are only requested at a word boundary (after a space, punctuation,
// a bracket or $, or at the start of a line): chat models are unreliable about
// leading spaces, so AutocompleteText.mjs decides the spacing by fixed rules.
const SYSTEM = `You are the inline autocomplete of a LaTeX editor. The user is typing; ‸ marks the cursor, which is always at the start of a new word.
Reply with only the text to insert at ‸: no explanation, no quotes, no code fences, no text that is already before or after ‸.
- Continue naturally: the next words of the sentence, or the LaTeX command or argument being written. One line at most, ideally under 15 words.
- If ‸ follows the end of a sentence, start the next sentence; never continue a finished sentence with a comma.
- Match the language, notation and style of the document. Close braces, brackets or $ only if the text after ‸ does not already close them.
- If nothing useful fits, reply with an empty message.`

// With corrections (the default), the same request also checks the sentence
// just typed; the reply is JSON so fixes and continuation stay apart.
const SYSTEM_WITH_FIXES = `You are the inline autocomplete and autocorrect of a LaTeX editor. The user is typing; ‸ marks the cursor, which is at the start of a new word.
Reply with JSON only: {"fixes": [{"wrong": "...", "right": "..."}], "text": "..."}
- "fixes": clear spelling or grammar mistakes in the sentence just before ‸ (at most 3). "wrong" is copied exactly from that text and "right" is its correction. Never change LaTeX commands, labels, citation keys, math, names, technical terms or the author's wording and style. Use [] when there is no clear mistake.
- "text": the text to insert at ‸, without a leading space: the next words of the (corrected) sentence, one line at most, ideally under 15 words. "" if nothing useful fits.
- If ‸ follows the end of a sentence, start the next sentence; never continue a finished sentence with a comma.
- Never repeat text that is before or after ‸. Close braces, brackets or $ only if the text after ‸ does not already close them.
- Match the language, notation and style of the document.`

function model() {
  return process.env.AI_AUTOCOMPLETE_MODEL || Settings.workbenchAi?.model
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
  const corrections = req.body?.corrections !== false
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
    system: corrections ? SYSTEM_WITH_FIXES : SYSTEM,
    prompt: `File: ${file}\n\n${before}‸${after}`,
    maxOutputTokens: corrections ? 120 : 48,
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
  if (!corrections) {
    return res.json({ completion: cleanCompletion(result.text, before, after), fixes: [] })
  }
  const reply = parseCorrectionReply(result.text)
  res.json({
    completion: reply ? cleanCompletion(reply.text, before, after) : '',
    fixes: reply ? placeFixes(reply.fixes, before) : [],
  })
}

export default { complete: expressify(complete) }
