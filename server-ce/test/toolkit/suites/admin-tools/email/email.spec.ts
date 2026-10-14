import { v4 as uuid } from 'uuid'
import { adminUserInfo, tryLogin } from '../../../../helpers/adminTools'
import { DEFAULT_PASSWORD, login } from '../../../../helpers/login'
import {
  activationLink,
  deleteEmails,
  emailsTo,
  refuseEmails,
  waitForEmail,
} from '../../../../helpers/mailpit'
import { postWithCsrf } from '../../../../helpers/request'
import {
  ADMIN_EMAIL,
  ensureAdminExists,
  ensureUserExists,
} from '../../../../helpers/users'

// admin-tools with email on: Overleaf sends through Mailpit
// (services/mailpit), which the tests read back. What the admin does to an
// account must not depend on the email going out.

// Like the Create account modal
function createAccount(email: string) {
  cy.visit('/admin/user')
  return postWithCsrf('/admin/user/create', {
    email,
    first_name: 'Mail',
    last_name: 'Test',
    isAdmin: false,
    isExternal: false,
  })
}

// Like the Delete modal with "send an email" checked
function deleteAccount(email: string) {
  return adminUserInfo(email).then(user =>
    postWithCsrf(`/admin/user/${user.id}/delete`, {
      sendEmail: true,
      toUserId: null,
    })
  )
}

before(function () {
  ensureAdminExists()
})

afterEach(function () {
  refuseEmails(false)
})

describe('creating accounts with email', function () {
  it('sends the activation email, whose link activates the account', function () {
    const email = `mail-new-${uuid()}@example.com`
    login(ADMIN_EMAIL)
    createAccount(email).its('status').should('equal', 200)

    waitForEmail(email).then(text => {
      cy.clearAllCookies()
      cy.visit(activationLink(text))
      cy.get('input[name="password"]').type(DEFAULT_PASSWORD)
      cy.findByRole('button', { name: 'Activate' }).click()
      cy.url().should('contain', '/project')
    })
  })

  it('creates the account when the email cannot be sent, and sends it again later', function () {
    const email = `mail-refused-${uuid()}@example.com`
    login(ADMIN_EMAIL)
    refuseEmails(true)
    createAccount(email).then(response => {
      expect(response.status).to.equal(200)
      expect(response.body.user.email).to.equal(email)
    })
    adminUserInfo(email).its('inactive').should('equal', true)
    emailsTo(email).should('have.length', 0)

    // Resending tells the admin while the email cannot go out
    adminUserInfo(email).then(user => {
      postWithCsrf(`/admin/user/${user.id}/send-activation`, {})
        .its('status')
        .should('equal', 422)
      refuseEmails(false)
      postWithCsrf(`/admin/user/${user.id}/send-activation`, {})
        .its('status')
        .should('equal', 200)
    })
    waitForEmail(email).should('contain', '/user/activate?token=')
  })
})

describe('deleting accounts with email', function () {
  it('deletes the account and tells the user', function () {
    const email = `mail-delete-${uuid()}@example.com`
    ensureUserExists(email)
    // drop the activation email
    deleteEmails()
    login(ADMIN_EMAIL)
    deleteAccount(email).its('status').should('equal', 200)

    waitForEmail(email).should('contain', 'deleted')
    tryLogin(email).its('status').should('equal', 401)
  })

  it('deletes the whole account when the email cannot be sent', function () {
    const email = `mail-delete-refused-${uuid()}@example.com`
    ensureUserExists(email)
    login(ADMIN_EMAIL)
    refuseEmails(true)
    deleteAccount(email).its('status').should('equal', 200)

    tryLogin(email).its('status').should('equal', 401)
  })
})
