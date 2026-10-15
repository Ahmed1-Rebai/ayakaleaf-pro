import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import WorkbenchController from './WorkbenchController.mjs'
import PermissionsMiddleware from './PermissionsMiddleware.mjs'
import { isConfigured } from './WorkbenchAiClient.mjs'
// LambdaTeX patch: saved conversations.
import ConversationController from './ConversationController.mjs'

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
