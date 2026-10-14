import { DEFAULT_PASSWORD, login } from './login'
import { postWithCsrf } from './request'

// The admin panel of the admin-tools module, /admin/user and /admin/project.

export function dialog() {
  return cy.findByRole('dialog')
}

export function searchBox() {
  // "Search…" for users, "Search projects ID, title…" for projects
  return cy.findByRole('textbox', { name: /^Search/ })
}

// Searching asks the server, so what was created after the page loaded shows
// up too. Waits for the answer: it renders the list again, which resets an
// open modal.
export function search(text: string) {
  cy.intercept('POST', /\/admin\/(users|projects)\/search$/).as('search')
  searchBox().clear().type(text)
  cy.wait('@search')
}

export function row(text: string) {
  return cy.contains('tbody tr', text)
}

export function rowAction(text: string, name: string | RegExp) {
  row(text).findByRole('button', { name }).click()
}

// The user as the admin's list reports it, or null. Expects to be logged in
// as admin.
export function adminUserInfo(email: string) {
  cy.visit('/admin/user')
  return postWithCsrf('/admin/users/search', { search: email }).then(
    response => {
      expect(response.status).to.equal(200)
      return (
        response.body.users.find((u: { email: string }) => u.email === email) ??
        null
      )
    }
  )
}

// Suspends or resumes the user like the suspend and resume buttons of the
// list. Expects to be logged in as admin.
export function setSuspended(email: string, suspended: boolean) {
  adminUserInfo(email).then(user => {
    postWithCsrf(`/admin/user/${user.id}/update`, { suspended })
      .its('status')
      .should('equal', 200)
  })
}

// Posts the login form like the login page does, without keeping the
// session. Answers {redir} where the page would go next, or 401.
export function tryLogin(email: string, password = DEFAULT_PASSWORD) {
  cy.clearAllCookies()
  cy.visit('/login')
  return cy
    .get('meta[name="ol-csrfToken"]')
    .invoke('attr', 'content')
    .then(csrfToken =>
      cy.request({
        method: 'POST',
        url: '/login',
        body: { email, password },
        headers: { 'X-Csrf-Token': csrfToken as string, Accept: 'application/json' },
        failOnStatusCode: false,
        followRedirect: false,
      })
    )
}

// How the user may access each of their projects that is not trashed, by id
export function projectAccess(
  email: string
): Cypress.Chainable<Record<string, string>> {
  login(email)
  return cy.request('/user/projects').then(response =>
    Object.fromEntries(
      response.body.projects.map(
        (p: { _id: string; accessLevel: string }) => [p._id, p.accessLevel]
      )
    )
  )
}

// Picks a user in the owner combobox of the delete and change owner modals.
// Its label is not tied to the input, the placeholder repeats it.
export function ownerInput() {
  return cy.findByPlaceholderText(/Select a new owner/)
}

export function selectNewOwner(email: string) {
  ownerInput().type(email)
  cy.findByRole('option', { name: new RegExp(email) }).click()
}
