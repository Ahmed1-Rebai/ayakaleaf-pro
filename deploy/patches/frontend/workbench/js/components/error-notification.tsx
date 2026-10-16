/**
 * Displays chat errors from a message or structured notification.
 * Uses a generic error notice when no details are supplied.
 * LambdaTeX patch: structured errors may offer "Try again" (retry) and report
 * dismissal, so each cause in ../ai-errors.ts gets its own message and action.
 */
import { useTranslation } from 'react-i18next'
import OLNotification from '@/shared/components/notification'
import OLButton from '@/shared/components/ol/ol-button'

export type WorkbenchError =
  | string
  | { title?: string; message?: string; type?: string; retry?: boolean }
  | boolean

export default function WorkbenchErrorNotification({
  content,
  onRetry,
  onDismiss,
}: {
  content: WorkbenchError
  onRetry?: () => void
  onDismiss?: () => void
}) {
  const { t } = useTranslation()
  switch (typeof content) {
    case 'string':
      return (
        <OLNotification
          title={t('error')}
          content={content}
          type="error"
          className="workbench-error-notification"
          isDismissible
          onDismiss={onDismiss}
        />
      )
    case 'object':
      return (
        <OLNotification
          title={content.title}
          content={content.message}
          type={(content.type as any) || 'error'}
          className="workbench-error-notification"
          isDismissible
          onDismiss={onDismiss}
          action={
            content.retry && onRetry ? (
              <OLButton variant="secondary" size="sm" onClick={onRetry}>
                Try again
              </OLButton>
            ) : undefined
          }
        />
      )
    default:
      return (
        <OLNotification
          title={t('somethings_gone_wrong')}
          content={t('weve_hit_a_problem_try_starting_a_new_chat')}
          type="error"
          className="workbench-error-notification"
          isDismissible
          onDismiss={onDismiss}
        />
      )
  }
}
