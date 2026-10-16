// Unit tests for deploy/patches/workbench/AiErrors.mjs (no server needed).
//   docker run --rm -v ~/lambdatex/deploy:/d:ro --entrypoint node <web image> /d/tests/ai_errors_test.mjs
// Errors are shaped like the AI SDK's (APICallError: statusCode + responseBody;
// RetryError wrapping lastError) and like Node's fetch failures.
import { classifyAiError, streamErrorText } from '../patches/workbench/AiErrors.mjs'

const results = {}
function check(name, ok, detail = '') {
  results[name] = Boolean(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`)
}
const api = (statusCode, responseBody, message = `HTTP ${statusCode}`) =>
  Object.assign(new Error(message), { name: 'AI_APICallError', statusCode, responseBody })
const retry = lastError => Object.assign(new Error('Failed after 3 attempts'), { name: 'AI_RetryError', lastError })
const fetchFailed = code => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) })

const cases = [
  ['gateway refuses connections', fetchFailed('ECONNREFUSED'), 'gateway_unreachable'],
  ['gateway host unknown', fetchFailed('ENOTFOUND'), 'gateway_unreachable'],
  ['gateway timeout (504)', api(504, 'Gateway Timeout'), 'gateway_unreachable'],
  ['model server down (LiteLLM 500, vLLM unreachable)', api(500, '{"error":{"message":"Cannot connect to host vllm-svc-coding:8001"}}'), 'gateway_error'],
  ['502 from a proxy', api(502, 'Bad Gateway'), 'gateway_error'],
  ['wrapped in a RetryError', retry(api(503, 'Service Unavailable')), 'gateway_error'],
  ['provider rate limit (Groq TPM)', api(429, '{"error":{"message":"Rate limit reached for model ... tokens per minute"}}'), 'gateway_busy'],
  ['LiteLLM budget exceeded', api(400, '{"error":{"message":"Budget has been exceeded! Current cost: 5.01, Max budget: 5.0","type":"budget_exceeded"}}'), 'gateway_budget'],
  ['OpenAI-style quota', api(429, '{"error":{"code":"insufficient_quota"}}'), 'gateway_budget'],
  ['context too long (vLLM)', api(400, "This model's maximum context length is 32768 tokens. However, you requested 41000 tokens"), 'context_too_long'],
  ['context too long (max_model_len)', api(400, 'Input length exceeds max_model_len'), 'context_too_long'],
  ['images not supported (Groq)', api(400, '{"error":{"message":"messages[1].content must be a string"}}'), 'images_unsupported'],
  ['images not supported (vLLM)', api(400, 'This model does not support image input'), 'images_unsupported'],
  ['bad API key', api(401, '{"error":{"message":"Invalid API key"}}'), 'gateway_auth'],
  ['key not allowed for the model', api(403, 'Forbidden'), 'gateway_auth'],
  ['model not found', api(404, '{"error":{"message":"The model `qwen-x` does not exist"}}'), 'model_unavailable'],
  ['model not found with 400', api(400, 'Invalid model name passed in model=qwen-x'), 'model_unavailable'],
  ['other 400', api(400, '{"error":{"message":"property reasoning_content is unsupported"}}'), 'request_rejected'],
  ['user stopped the reply', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }), 'aborted'],
  ['something else', new Error('boom'), 'unknown'],
  ['not even an Error', 'boom', 'unknown'],
]
for (const [name, err, expected] of cases) {
  const { code, detail } = classifyAiError(err)
  check(name, code === expected, `-> ${code}`)
  if (code !== expected) console.log('   detail:', detail)
}
const { status, detail } = classifyAiError(api(500, 'x'.repeat(5000)))
check('status is kept and detail is one short line', status === 500 && detail.length <= 240 && !detail.includes('\n'))
const back = classifyAiError(new Error(streamErrorText('context_too_long')))
check('our own stream text coming back keeps its code and is marked as a repeat', back.code === 'context_too_long' && back.repeat === true)
check('a first-time error is not a repeat', classifyAiError(api(500, 'x')).repeat === false)
check('stream text starts with the code', streamErrorText('gateway_busy').startsWith('[gateway_busy] '))

const failed = Object.entries(results).filter(([, ok]) => !ok).map(([name]) => name)
console.log(`\nSUMMARY ${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed${failed.length ? `; failed: ${failed.join(', ')}` : ''}`)
process.exit(failed.length ? 1 : 0)
