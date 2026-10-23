import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.parse('2026-10-23T12:00:00.000Z')
const HOME = '/home/u'
const CONFIG = `${HOME}/.claude.json`
const CREDENTIALS = `${HOME}/.claude/.credentials.json`

const status: { current: string | undefined } = { current: undefined }

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80 },
} as const

type Login = { uuid: string; name: string; email: string; sub: string; tier: string }

const ALEX: Login = { uuid: 'a', name: 'Alex Cherry Pi', email: 'alex@example.com', sub: 'team', tier: 'default_claude_max_5x' }
const BEA: Login = { uuid: 'b', name: 'Bea Muster', email: 'bea@example.com', sub: 'max', tier: 'default_claude_max_20x' }

let mtime = 1

// ~/.claude.json and ~/.claude/.credentials.json beneath the plugin.
function world(on: On) {
  status.current = undefined
  const files = new Map<string, { text: string; mtimeMs: number }>()
  mock.env(on, { HOME })
  on('ui.status', (_$, e) => {
    status.current = e.text
    return { value: undefined } as never
  })
  on('session.start', () => ({ cwd: '/' }) as never)
  // What another plugin (limit-bars, say) draws in the band beneath this one.
  const beneath: { current: unknown } = { current: { type: 'Box', props: {}, children: [] } }
  on('ui.render', () => beneath.current as never)
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }) as never)
  on('fs.stat', (_$, e) => {
    const f = files.get(e.path)
    if (!f) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } } as never
  })
  on('fs.read', (_$, e) => {
    const f = files.get(e.path)
    if (!f) throw new Error(`ENOENT ${e.path}`)
    return { value: f.text } as never
  })
  const clock = mock.clock(on, { now: NOW })
  const login = (l: Login) => {
    const cfg = { oauthAccount: { accountUuid: l.uuid, displayName: l.name, emailAddress: l.email } }
    files.set(CONFIG, { text: JSON.stringify(cfg), mtimeMs: mtime++ })
    const cred = { claudeAiOauth: { accessToken: 'x', subscriptionType: l.sub, rateLimitTier: l.tier } }
    files.set(CREDENTIALS, { text: JSON.stringify(cred), mtimeMs: mtime++ })
  }
  return { clock, login, beneath }
}

describe('account-display', () => {
  test('bottom by default: name, email and plan in the status line', async ($, on) => {
    const { login } = world(on)
    login(ALEX)
    await $.session.start({ cwd: '/' } as never)
    expect(status.current).toBe('Alex Cherry Pi · alex@example.com · Team Premium')
  })

  test('only the fields switched on', { options: { lastName: false, plan: false } }, async ($, on) => {
    const { login } = world(on)
    login(ALEX)
    await $.session.start({ cwd: '/' } as never)
    expect(status.current).toBe('Alex · alex@example.com')
  })

  test('top: a row above the prompt, no status line', { options: { position: 'top' } }, async ($, on) => {
    const { login } = world(on)
    login(BEA)
    await $.session.start({ cwd: '/' } as never)
    expect(status.current).toBeUndefined()
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'account-display', surface, ...BAND } as never)
      expect(await ui.find({ type: 'Text', text: 'Bea Muster · bea@example.com · Max 20x' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('top: what another plugin draws in the band stays under the row', { options: { position: 'top' } }, async ($, on) => {
    const { login, beneath } = world(on)
    beneath.current = { type: 'Text', props: {}, children: ['5h bars'] }
    login(BEA)
    await $.session.start({ cwd: '/' } as never)
    const ui = await $.ui.mount({ plugin: 'account-display', surface: 'terminal', ...BAND } as never)
    expect(await ui.find({ type: 'Text', text: 'Bea Muster · bea@example.com · Max 20x' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '5h bars' })).toBeDefined()
    await ui.unmount()
  })

  test('plan names', async ($, on) => {
    const { clock, login } = world(on)
    const cases: [string, string, string][] = [
      ['pro', 'default_claude_pro', 'Pro'],
      ['max', 'default_claude_max_5x', 'Max 5x'],
      ['team', 'default_claude_team_standard', 'Team Standard'],
      ['enterprise', '', 'Enterprise'],
    ]
    login({ ...ALEX, sub: 'free', tier: '' })
    await $.session.start({ cwd: '/' } as never)
    expect(status.current).toBe('Alex Cherry Pi · alex@example.com · Free')
    for (const [sub, tier, plan] of cases) {
      login({ ...ALEX, sub, tier })
      await clock.advance(2_500)
      expect(status.current).toBe(`Alex Cherry Pi · alex@example.com · ${plan}`)
    }
  })

  test('follows an account switch', async ($, on) => {
    const { clock, login } = world(on)
    login(ALEX)
    await $.session.start({ cwd: '/' } as never)
    login(BEA)
    await clock.advance(2_500)
    expect(status.current).toBe('Bea Muster · bea@example.com · Max 20x')
  })
})
