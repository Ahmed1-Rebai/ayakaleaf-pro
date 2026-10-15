/**
 * LambdaTeX: "AI autocomplete" and "AI corrections" switches in Settings →
 * Editor, for users with access to the AI features. Registered as a
 * settingsModalEditorTabSections module entry (deploy/frontend/register-modules.cjs).
 * The choices are kept per browser and apply to open editors at once.
 */
import { useState } from 'react'
import ToggleSetting from '@/features/ide-settings/components/toggle-setting'
import type { SettingsSection } from '@/features/ide-settings/context/types'
import useAiAccess from '../hooks/use-ai-access'
import {
  isAiAutocompleteEnabled,
  isAiCorrectionsEnabled,
  setAiAutocompleteEnabled,
  setAiCorrectionsEnabled,
} from '../codemirror/ai-autocomplete'

function AiAutocompleteSettings() {
  const [autocomplete, setAutocomplete] = useState(isAiAutocompleteEnabled)
  const [corrections, setCorrections] = useState(isAiCorrectionsEnabled)
  return (
    <>
      <ToggleSetting
        id="aiAutocomplete"
        label="AI autocomplete"
        description="Suggests how to continue the line as grey text when you pause after a space or punctuation in LaTeX files. Press Tab to accept, Esc to dismiss."
        checked={autocomplete}
        onChange={value => {
          setAiAutocompleteEnabled(value)
          setAutocomplete(value)
        }}
      />
      <ToggleSetting
        id="aiCorrections"
        label="AI corrections"
        description="Also checks the sentence you just typed: spelling and grammar mistakes are shown struck out with the fix next to them, and Tab applies them."
        checked={autocomplete && corrections}
        disabled={!autocomplete}
        onChange={value => {
          setAiCorrectionsEnabled(value)
          setCorrections(value)
        }}
      />
    </>
  )
}

export default function useAiAutocompleteSettingsSection(): SettingsSection | null {
  const allowed = useAiAccess('chat')
  if (!allowed) return null
  return {
    key: 'ai-autocomplete',
    title: 'AI',
    settings: [{ key: 'aiAutocomplete', component: <AiAutocompleteSettings /> }],
  }
}
