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

type Login = { uuid: string; name: string; email: string; sub: string; tier: string; planDisplayName?: string; seatTier?: string }

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
  // macOS: the login is in the keychain, which answers after keychainMs.
  const keychain = { current: null as Login | null, ms: 0, reads: 0 }
  on('process.run', async () => {
    keychain.reads += 1
    if (keychain.ms) await clock.sleep(keychain.ms)
    const l = keychain.current
    if (!l) return { value: { exitCode: 44, stdout: '', stderr: '' } } as never
    const cred = { claudeAiOauth: { accessToken: 'x', subscriptionType: l.sub, rateLimitTier: l.tier } }
    return { value: { exitCode: 0, stdout: JSON.stringify(cred), stderr: '' } } as never
  })
  const clock = mock.clock(on, { now: NOW })
  const login = (l: Login, { mac = false } = {}) => {
    const cfg = { oauthAccount: { accountUuid: l.uuid, displayName: l.name, emailAddress: l.email, planDisplayName: l.planDisplayName, seatTier: l.seatTier } }
    files.set(CONFIG, { text: JSON.stringify(cfg), mtimeMs: mtime++ })
    if (mac) {
      files.set('/usr/bin/security', { text: '', mtimeMs: 0 })
      files.set('/System/Library/CoreServices', { text: '', mtimeMs: 0 })
      keychain.current = l
      return
    }
    const cred = { claudeAiOauth: { accessToken: 'x', subscriptionType: l.sub, rateLimitTier: l.tier } }
    files.set(CREDENTIALS, { text: JSON.stringify(cred), mtimeMs: mtime++ })
  }
  const halfWritten = () => files.set(CONFIG, { text: '{"oauthAcc', mtimeMs: mtime++ })
  return { clock, login, beneath, keychain, halfWritten }
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

  test('plan names: every combination Claude Code tells apart', async ($, on) => {
    const { clock, login } = world(on)
    const cases: [string, string, string | undefined, string][] = [
      ['pro', 'default_claude_pro', undefined, 'Pro'],
      ['pro', 'default_claude_zero', undefined, 'Pro (no allowance)'],
      ['max', 'default_claude_max_5x', undefined, 'Max 5x'],
      ['max', 'default_claude_max_20x', undefined, 'Max 20x'],
      ['max', 'something_else', undefined, 'Max'],
      ['max', 'default_claude_zero', undefined, 'Max (no allowance)'],
      ['team', 'default_claude_max_5x', undefined, 'Team Premium'],
      // A real Team Premium seat (macOS, 2026-10): no planDisplayName in ~/.claude.json.
      ['team', 'default_claude_max_5x', 'team_tier_1', 'Team Premium'],
      ['team', 'default_claude_team', undefined, 'Team Standard'],
      ['team', '', undefined, 'Team'],
      ['team', 'default_claude_zero', undefined, 'Team (no allowance)'],
      ['enterprise', '', undefined, 'Enterprise'],
      ['enterprise', 'default_claude_enterprise', 'enterprise_usage_based', 'Enterprise (usage-based)'],
      ['enterprise', 'default_claude_zero', undefined, 'Enterprise (no allowance)'],
    ]
    login({ ...ALEX, sub: 'pro', tier: '' })
    await $.session.start({ cwd: '/' } as never)
    for (const [i, [sub, tier, seatTier, plan]] of cases.entries()) {
      login({ ...ALEX, uuid: `u${i}`, sub, tier, seatTier })
      await clock.advance(1_000)
      expect(status.current).toBe(`Alex Cherry Pi · alex@example.com · ${plan}`)
    }
  })

  test('follows an account switch', async ($, on) => {
    const { clock, login } = world(on)
    login(ALEX)
    await $.session.start({ cwd: '/' } as never)
    login(BEA)
    await clock.advance(1_000)
    expect(status.current).toBe('Bea Muster · bea@example.com · Max 20x')
  })

  test('top: the band shows the new account within a second of a switch', { options: { position: 'top' } }, async ($, on) => {
    const { clock, login } = world(on)
    login(ALEX)
    await $.session.start({ cwd: '/' } as never)
    login(BEA)
    await clock.advance(1_000)
    const ui = await $.ui.mount({ plugin: 'account-display', surface: 'terminal', ...BAND } as never)
    expect(await ui.find({ type: 'Text', text: 'Bea Muster · bea@example.com · Max 20x' })).toBeDefined()
    await ui.unmount()
  })

  test('a half-written ~/.claude.json is no switch', async ($, on) => {
    const { clock, login, halfWritten } = world(on)
    login(ALEX)
    await $.session.start({ cwd: '/' } as never)
    halfWritten()
    await clock.advance(1_000)
    expect(status.current).toBe('Alex Cherry Pi · alex@example.com · Team Premium')
    login(BEA)
    await clock.advance(1_000)
    expect(status.current).toBe('Bea Muster · bea@example.com · Max 20x')
  })

  test('macOS: name and email at once, the plan when the keychain answers, never the old one', async ($, on) => {
    const { clock, login, keychain } = world(on)
    login(ALEX, { mac: true })
    await $.session.start({ cwd: '/' } as never)
    expect(status.current).toBe('Alex Cherry Pi · alex@example.com · Team Premium')
    const reads = keychain.reads
    await clock.advance(5_000)
    expect(keychain.reads).toBe(reads) // no switch, no keychain read
    keychain.ms = 3_000
    login(BEA, { mac: true })
    await clock.advance(1_000)
    expect(status.current).toBe('Bea Muster · bea@example.com')
    await clock.advance(3_000)
    expect(status.current).toBe('Bea Muster · bea@example.com · Max 20x')
  })

  test('macOS: an old .credentials.json beside the keychain is not taken for the plan', async ($, on) => {
    const { login } = world(on)
    login({ ...BEA, uuid: 'old', sub: 'pro', tier: '' }) // leaves a file with Pro behind
    login(BEA, { mac: true })
    await $.session.start({ cwd: '/' } as never)
    expect(status.current).toBe('Bea Muster · bea@example.com · Max 20x')
  })

  test('the plan name Claude Code keeps in ~/.claude.json comes first, with no keychain read', async ($, on) => {
    const { clock, login, keychain } = world(on)
    login(ALEX, { mac: true })
    await $.session.start({ cwd: '/' } as never)
    const reads = keychain.reads
    keychain.ms = 3_000
    login({ ...BEA, planDisplayName: 'Team Premium' }, { mac: true })
    await clock.advance(1_000)
    expect(status.current).toBe('Bea Muster · bea@example.com · Team Premium')
    expect(keychain.reads).toBe(reads)
  })
})
