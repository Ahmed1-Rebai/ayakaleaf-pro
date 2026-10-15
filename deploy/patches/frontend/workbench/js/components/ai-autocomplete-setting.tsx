/**
 * LambdaTeX: "AI autocomplete" switch in Settings → Editor, for users with
 * access to the AI features. Registered as a settingsModalEditorTabSections
 * module entry (deploy/frontend/register-modules.cjs). The choice is kept per
 * browser and applies to open editors at once.
 */
import { useState } from 'react'
import ToggleSetting from '@/features/ide-settings/components/toggle-setting'
import type { SettingsSection } from '@/features/ide-settings/context/types'
import useAiAccess from '../hooks/use-ai-access'
import {
  isAiAutocompleteEnabled,
  setAiAutocompleteEnabled,
} from '../codemirror/ai-autocomplete'

function AiAutocompleteSetting() {
  const [enabled, setEnabled] = useState(isAiAutocompleteEnabled)
  return (
    <ToggleSetting
      id="aiAutocomplete"
      label="AI autocomplete"
      description="Suggests how to continue the line as grey text while you type in LaTeX files. Press Tab to accept, Esc to dismiss."
      checked={enabled}
      onChange={value => {
        setAiAutocompleteEnabled(value)
        setEnabled(value)
      }}
    />
  )
}

export default function useAiAutocompleteSettingsSection(): SettingsSection | null {
  const allowed = useAiAccess('chat')
  if (!allowed) return null
  return {
    key: 'ai-autocomplete',
    title: 'AI',
    settings: [{ key: 'aiAutocomplete', component: <AiAutocompleteSetting /> }],
  }
}
