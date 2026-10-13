import { zz } from '../../../../app/src/infrastructure/Validation.mjs'

export const filePath = zz
  .filepath()
  .describe('Path of the file in the project, e.g. "sections/intro.tex".')

export function text(value) {
  return {
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  }
}

export async function checkAccess(canUser, userId, projectId, message) {
  if (!(await canUser(userId, projectId))) throw new Error(message)
}
