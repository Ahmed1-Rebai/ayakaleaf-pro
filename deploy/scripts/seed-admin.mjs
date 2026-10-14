// Ensure the admin account from .env exists: SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD.
// Runs inside the sharelatex container, mounted next to upstream's admin scripts;
// deploy/scripts/seed-admin.sh pipes three lines on stdin: email, password and an
// optional existing account to rename (so it keeps its projects).
import { db } from '../../../../app/src/infrastructure/mongodb.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import UserUpdater from '../../../../app/src/Features/User/UserUpdater.mjs'
import UserRegistrationHandler from '../../../../app/src/Features/User/UserRegistrationHandler.mjs'
import AuthenticationManager from '../../../../app/src/Features/Authentication/AuthenticationManager.mjs'

async function readStdin() {
  let data = ''
  for await (const chunk of process.stdin) data += chunk
  const [email = '', password = '', replace = ''] = data.split('\n').map(s => s.trim())
  return { email, password, replace }
}

async function main() {
  const { email, password, replace } = await readStdin()
  if (!email || !password) throw new Error('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required')

  let user = await UserGetter.promises.getUserByAnyEmail(email, { _id: 1, email: 1 })
  let action = 'exists'
  if (!user && replace) {
    const old = await UserGetter.promises.getUserByAnyEmail(replace, { _id: 1 })
    if (old) {
      await UserUpdater.promises.changeEmailAddress(old._id, email, { initiatorId: old._id, ipAddress: '127.0.0.1' })
      user = await UserGetter.promises.getUser(old._id, { _id: 1, email: 1 })
      action = `renamed from ${replace}`
    }
  }
  if (!user) {
    user = await UserRegistrationHandler.promises.registerNewUser({ email, password })
    action = 'created'
  }
  await db.users.updateOne({ _id: user._id }, { $set: { isAdmin: true } })

  let passwordState = 'updated'
  try {
    await AuthenticationManager.promises.setUserPassword(user, password)
  } catch (err) {
    if (err?.name !== 'PasswordMustBeDifferentError') throw err
    passwordState = 'unchanged'
  }
  if (action === 'created') passwordState = 'set'
  console.log(`admin ${email}: ${action}; password ${passwordState}; isAdmin true`)
}

try {
  await main()
  process.exit(0)
} catch (error) {
  console.error(`seed-admin failed: ${error?.info?.code || ''} ${error?.message || error}`)
  process.exit(1)
}
