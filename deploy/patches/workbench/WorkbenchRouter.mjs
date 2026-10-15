import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import WorkbenchController from './WorkbenchController.mjs'
import PermissionsMiddleware from './PermissionsMiddleware.mjs'
import { isConfigured } from './WorkbenchAiClient.mjs'
// LambdaTeX patch: saved conversations.
import ConversationController from './ConversationController.mjs'
// LambdaTeX patch: AI autocomplete in the editor.
import AutocompleteController from './AutocompleteController.mjs'
import RateLimiterMiddleware from '../../../../app/src/Features/Security/RateLimiterMiddleware.mjs'
import { RateLimiter } from '../../../../app/src/infrastructure/RateLimiter.mjs'

// A pause in typing triggers one request; this only stops runaway clients.
const autocompleteRateLimiter = new RateLimiter('workbench-autocomplete', {
  points: 120,
  duration: 60,
})

export default {
  apply(webRouter) {
    webRouter.use('/project', (req, res, next) => {
      res.locals.ExposedSettings.aiAvailable = isConfigured()
      next()
    })
    webRouter.get(
      '/workbench/access',
      AuthenticationController.requireLogin(),
      WorkbenchController.getAccess
    )
    // LambdaTeX patch: saved conversations (list, open, rename, delete).
    webRouter.get(
      '/workbench/conversations',
      AuthenticationController.requireLogin(),
      ConversationController.list
    )
    webRouter.get(
      '/workbench/conversations/:conversationId',
      AuthenticationController.requireLogin(),
      ConversationController.get
    )
    webRouter.post(
      '/workbench/conversations/:conversationId/rename',
      AuthenticationController.requireLogin(),
      ConversationController.rename
    )
    webRouter.delete(
      '/workbench/conversations/:conversationId',
      AuthenticationController.requireLogin(),
      ConversationController.remove
    )
    // LambdaTeX: inline suggestions while typing (AutocompleteController.mjs)
    webRouter.post(
      '/workbench/autocomplete',
      AuthenticationController.requireLogin(),
      PermissionsMiddleware.requireAiAccess,
      RateLimiterMiddleware.rateLimit(autocompleteRateLimiter),
      AutocompleteController.complete
    )

    // Workbench AI chat (Vercel AI SDK useChat endpoint). The global JSON body
    // parser (12 MB by default) handles the UI-message history payload.
    webRouter.post(
      '/workbench/tex-gpt',
      AuthenticationController.requireLogin(),
      PermissionsMiddleware.requireAiAccess,
      WorkbenchController.texGpt
    )
  },
}
