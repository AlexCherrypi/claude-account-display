import type { EngineInterface, Register } from 'claude-code'

// Account display
//
// One line that says who is signed in: first and last name, email and plan, separated by
// " · ", e.g. "Alex Cherry · alex@example.com · Team Premium". Which of them show and
// where (a row above the prompt, or the status line under it) the person picks in the
// plugin's options.
//
// Name, email: `oauthAccount` in ~/.claude.json (displayName, emailAddress).
// Plan: the login itself (`claudeAiOauth.subscriptionType` and `rateLimitTier`), kept in
// ~/.claude/.credentials.json, or on macOS in the keychain item Claude Code-credentials.
//
// After an account switch (/login, an account switcher) the line follows at once: every
// 2 seconds the files are looked at (a stat, read only when it changed); the keychain is
// read only when the account in ~/.claude.json changed.

type Field = 'firstName' | 'lastName' | 'email' | 'plan'
const FIELDS: readonly Field[] = ['firstName', 'lastName', 'email', 'plan']

type Account = {
  uuid: string | null
  firstName: string | null
  lastName: string | null
  email: string | null
  plan: string | null
}

type Position = 'top' | 'bottom'

const WATCH_MS = 2_000
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const SEPARATOR = ' · '

let position: Position = 'bottom'
let shown: Field[] = [...FIELDS]
let account: Account | null = null
let line: string | undefined
let lastStatus: string | undefined
let configStamp: string | null = null
let credentialsStamp: string | null = null
let tokens: { subscriptionType: string | null; rateLimitTier: string | null } | null = null
let tokensFor: string | null | undefined
let ticking = false
let timers: { cancel: () => void }[] = []

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function trimSlash(p: string): string {
  return p.replace(/[\\/]+$/, '')
}

// ---------------------------------------------------------------- Where things are

async function isWindows($: EngineInterface): Promise<boolean> {
  return (await safe(() => $.env.get('OS'))) === 'Windows_NT'
}

// The home folder as Claude Code's os.homedir() sees it: USERPROFILE on Windows, HOME
// everywhere else.
async function home($: EngineInterface): Promise<string | null> {
  const h = (await isWindows($))
    ? (await safe(() => $.env.get('USERPROFILE'))) || (await safe(() => $.env.get('HOME')))
    : (await safe(() => $.env.get('HOME'))) || (await safe(() => $.env.get('USERPROFILE')))
  return h ? trimSlash(h) : null
}

// ~/.claude.json, or .claude.json inside CLAUDE_CONFIG_DIR.
async function configPath($: EngineInterface): Promise<string | null> {
  const dir = await safe(() => $.env.get('CLAUDE_CONFIG_DIR'))
  const base = dir ? trimSlash(dir) : await home($)
  return base ? `${base}/.claude.json` : null
}

// <CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json
async function credentialsPath($: EngineInterface): Promise<string | null> {
  const secure = await safe(() => $.env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR'))
  const dir = secure || (await safe(() => $.env.get('CLAUDE_CONFIG_DIR')))
  if (dir) return `${trimSlash(dir)}/.credentials.json`
  const h = await home($)
  return h ? `${h}/.claude/.credentials.json` : null
}

async function isMac($: EngineInterface): Promise<boolean> {
  if (await isWindows($)) return false
  return Boolean((await safe(() => $.fs.exists('/usr/bin/security'))) && (await safe(() => $.fs.exists('/System/Library/CoreServices'))))
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// "Claude Code-credentials", with "-<first 8 hex of sha256(config dir)>" behind it when
// CLAUDE_CONFIG_DIR is set.
async function keychainService($: EngineInterface): Promise<string> {
  const secure = await safe(() => $.env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR'))
  const dir = secure || (await safe(() => $.env.get('CLAUDE_CONFIG_DIR')))
  return dir ? `${KEYCHAIN_SERVICE}-${(await sha256Hex(trimSlash(dir).normalize('NFC'))).slice(0, 8)}` : KEYCHAIN_SERVICE
}

// ---------------------------------------------------------------- Reading

async function stampOf($: EngineInterface, path: string | null): Promise<string | null> {
  if (!path) return null
  const st = await safe(() => $.fs.stat(path))
  return st ? `${st.mtimeMs}:${st.size}` : null
}

async function readJson($: EngineInterface, path: string): Promise<Record<string, unknown> | null> {
  const text = await safe(() => $.fs.read(path))
  if (typeof text !== 'string') return null
  try {
    const doc = JSON.parse(text)
    return isObject(doc) ? doc : null
  } catch {
    return null
  }
}

function tokensOf(doc: Record<string, unknown> | null): typeof tokens {
  const t = doc?.claudeAiOauth
  if (!isObject(t)) return null
  return { subscriptionType: str(t.subscriptionType), rateLimitTier: str(t.rateLimitTier) }
}

async function readKeychain($: EngineInterface): Promise<Record<string, unknown> | null | undefined> {
  const user = (await safe(() => $.env.get('USER'))) || 'claude-code-user'
  const service = await keychainService($)
  const r = await safe(() => $.process.run(['security', 'find-generic-password', '-a', user, '-w', '-s', service], { timeoutMs: 10_000 }))
  if (!r || r.exitCode !== 0) return undefined
  let out = r.stdout.trim()
  // `security -w` prints the data as hex when it is not plain text.
  if (!out.startsWith('{') && /^[0-9a-f]+$/i.test(out)) {
    out = new TextDecoder().decode(new Uint8Array(out.match(/../g)!.map(b => parseInt(b, 16))))
  }
  try {
    const doc = JSON.parse(out)
    return isObject(doc) ? doc : null
  } catch {
    return null
  }
}

// The plan as people know it: "Pro", "Max 20x", "Team Premium", "Enterprise".
function planName(subscriptionType: string | null, rateLimitTier: string | null): string | null {
  const sub = subscriptionType?.toLowerCase() ?? null
  const tier = rateLimitTier?.toLowerCase() ?? ''
  const multiplier = tier.match(/(\d+)x/)?.[1]
  const seat = /premium/.test(tier) || multiplier ? 'Premium' : /standard/.test(tier) ? 'Standard' : null
  switch (sub) {
    case null:
      return null
    case 'free':
      return 'Free'
    case 'pro':
      return 'Pro'
    case 'max':
      return multiplier ? `Max ${multiplier}x` : 'Max'
    case 'team':
      return seat ? `Team ${seat}` : 'Team'
    case 'enterprise':
      return seat ? `Enterprise ${seat}` : 'Enterprise'
    default:
      return sub
        .split(/[_\s-]+/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')
  }
}

// Reads what changed since the last look; true when the account shown changed.
async function look($: EngineInterface): Promise<boolean> {
  const cfgPath = await configPath($)
  const credPath = await credentialsPath($)
  const cfgStamp = await stampOf($, cfgPath)
  const credStamp = await stampOf($, credPath)
  if (cfgStamp === configStamp && credStamp === credentialsStamp && account) return false

  let oauth: Record<string, unknown> | null = null
  if (cfgPath && cfgStamp) {
    const cfg = await readJson($, cfgPath)
    // Half written: try again at the next look.
    if (!cfg) return false
    oauth = isObject(cfg.oauthAccount) ? cfg.oauthAccount : null
  }
  configStamp = cfgStamp
  const uuid = str(oauth?.accountUuid)

  // The plan: from the file where it changed; from the keychain on macOS only when the
  // account did (a keychain read is a process).
  if (credStamp !== credentialsStamp || tokensFor !== uuid) {
    credentialsStamp = credStamp
    let doc = credPath && credStamp ? await readJson($, credPath) : null
    if (!tokensOf(doc) && tokensFor !== uuid && (await isMac($))) doc = (await readKeychain($)) ?? null
    tokens = tokensOf(doc)
    tokensFor = uuid
  }

  const name = str(oauth?.displayName)?.split(/\s+/) ?? []
  const next: Account = {
    uuid,
    firstName: name[0] ?? null,
    lastName: name.length > 1 ? name.slice(1).join(' ') : null,
    email: str(oauth?.emailAddress),
    plan: oauth ? planName(tokens?.subscriptionType ?? null, tokens?.rateLimitTier ?? null) : null,
  }
  const changed = JSON.stringify(next) !== JSON.stringify(account)
  account = next
  return changed
}

// ---------------------------------------------------------------- Drawing

function lineOf(a: Account | null): string | undefined {
  if (!a) return undefined
  // First and last name stay one part: "Alex Cherry", not "Alex · Cherry".
  const name = (['firstName', 'lastName'] as const).filter(f => shown.includes(f) && a[f]).map(f => a[f]).join(' ')
  const parts = [name, shown.includes('email') ? a.email : null, shown.includes('plan') ? a.plan : null]
    .filter((p): p is string => Boolean(p))
  return parts.length ? parts.join(SEPARATOR) : undefined
}

function refresh($: EngineInterface): void {
  line = lineOf(account)
  const status = position === 'bottom' ? line : undefined
  if (status !== lastStatus) {
    lastStatus = status
    $.ui.status(status)
  }
  if (position === 'top') $.ui.invalidate('ui.render')
}

async function tick($: EngineInterface): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    if (await look($)) refresh($)
  } catch {
    // the next look tries again
  } finally {
    ticking = false
  }
}

export const register: Register = (on, options) => {
  position = options.position === 'top' ? 'top' : 'bottom'
  shown = FIELDS.filter(f => options[f] !== false)
  account = null
  line = undefined
  lastStatus = undefined
  configStamp = null
  credentialsStamp = null
  tokens = null
  tokensFor = undefined
  ticking = false
  timers = []

  on('session.start', async ($, e, next) => {
    for (const t of timers) t.cancel()
    timers = []
    await tick($)
    refresh($)
    timers.push($.clock.every(WATCH_MS, () => void tick($)))
    return next(e)
  })

  // The row above the prompt, over whatever another plugin draws there.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (position !== 'top' || e.props.hasSurvey || !line) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">
          {line}
        </Text>
        {below}
      </Box>
    )
  })
}
