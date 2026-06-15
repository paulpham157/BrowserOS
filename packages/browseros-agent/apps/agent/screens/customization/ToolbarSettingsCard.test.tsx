import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { type ComponentProps, createElement, type FC } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

type LabelProps = ComponentProps<'label'>

type SwitchProps = ComponentProps<'button'> & {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
}

mock.module('sonner', () => ({
  toast: { error: () => {} },
}))

mock.module('@/components/ui/label', () => ({
  Label: ({ children, ...props }: LabelProps) =>
    createElement('label', props, children),
}))

mock.module('@/components/ui/switch', () => ({
  Switch: ({
    checked: _checked,
    onCheckedChange: _onCheckedChange,
    ...props
  }: SwitchProps) =>
    createElement('button', { type: 'button', role: 'switch', ...props }),
}))

mock.module('@/lib/browseros/adapter', () => ({
  getBrowserOSAdapter: () => ({
    getPref: async () => null,
    setPref: async () => true,
  }),
}))

mock.module('@/lib/browseros/prefs', () => ({
  BROWSEROS_PREFS: {
    SHOW_LLM_CHAT: 'browseros.show_llm_chat',
    SHOW_TOOLBAR_LABELS: 'browseros.show_toolbar_labels',
    VERTICAL_TABS_ENABLED: 'browseros.vertical_tabs_enabled',
  },
}))

mock.module('@/lib/browseros/capabilities', () => ({
  Capabilities: {
    supports: async () => false,
  },
  Feature: {
    VERTICAL_TABS_SUPPORT: 'VERTICAL_TABS_SUPPORT',
  },
}))

let ToolbarSettingsCard: FC

beforeAll(async () => {
  ToolbarSettingsCard = (await import('./ToolbarSettingsCard'))
    .ToolbarSettingsCard
})

function renderCard() {
  return renderToStaticMarkup(createElement(ToolbarSettingsCard))
}

describe('ToolbarSettingsCard', () => {
  it('renders supported toolbar settings without the unsupported Hub control', () => {
    const html = renderCard()

    expect(html).toContain('Show Chat Button')
    expect(html).toContain('Show Button Labels')
    expect(html).not.toContain('Show Hub Button')
    expect(html).not.toContain('show-llm-hub')
  })
})
