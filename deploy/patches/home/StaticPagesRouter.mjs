/* eslint-disable
    max-len,
*/
// TODO: This file was created by bulk-decaffeinate.
// Fix any style issues and re-enable lint.
/*
 * decaffeinate suggestions:
 * DS102: Remove unnecessary code created because of implicit returns
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
import HomeController from './HomeController.mjs'
import AuthenticationController from '../Authentication/AuthenticationController.mjs'

import UniversityController from './UniversityController.mjs'

export default {
  apply(webRouter) {
    // LambdaTeX: the welcome page is public, even without OVERLEAF_ALLOW_PUBLIC_ACCESS
    if (HomeController.welcomePage) {
      AuthenticationController.addEndpointToLoginWhitelist('/')
      AuthenticationController.addEndpointToLoginWhitelist('/home')
    }
    webRouter.get('/', HomeController.index)
    webRouter.get('/home', HomeController.home)

    webRouter.get(
      '/planned_maintenance',
      HomeController.externalPage('planned_maintenance', 'Planned Maintenance')
    )

    webRouter.get('/university', UniversityController.getIndexPage)
    return webRouter.get('/university/*', UniversityController.getPage)
  },
}
