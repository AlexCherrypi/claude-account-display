import type { EngineInterface, Register } from 'claude-code'

// Account display
//
// One line that says who is signed in: first and last name, email and plan, separated by
// " · ", e.g. "Alex Cherry · alex@example.com · Team Premium". Which of them show and
// where (a row above the prompt, or the status line under it) the person picks in the
// plugin's options.
//
// Name, email, plan: `oauthAccount` in ~/.claude.json (displayName, emailAddress,
// planDisplayName – the plan's name as Claude Code shows it). Where an older record has no
// planDisplayName, the plan is made from the login itself (`claudeAiOauth.subscriptionType`
// and `rateLimitTier`), kept in ~/.claude/.credentials.json, or on macOS in the keychain
// item Claude Code-credentials.
//
// After an account switch (/login, an account switcher) the line follows at once, as
// limit-bars does: every second the files are looked at (a stat, read only when it
// changed), and a switch draws the new account right away. The keychain is read only when
// the account in ~/.claude.json changed.

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

const WATCH_MS = 1_000 // how often the files are looked at (a stat; read only when it changed)
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const SEPARATOR = ' · '

let position: Position = 'bottom'
let shown: Field[] = [...FIELDS]
let account: Account | null = null
let line: string | undefined
let lastStatus: string | undefined
let configStamp: string | null = null
let credentialsStamp: string | null = null
let configFile: string | null | undefined
let mac: boolean | undefined
let usesKeychain = false
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

// The engine's global config, found as the engine finds it (as limit-bars does): an older
// install's <$CLAUDE_CONFIG_DIR or ~/.claude>/.config.json while that holds anything, else
// $CLAUDE_CONFIG_DIR/.claude.json or ~/.claude.json – .claude-custom-oauth.json with a
// custom OAuth URL.
async function configPath($: EngineInterface): Promise<string | null> {
  if (configFile !== undefined) return configFile
  const homeDir = await home($)
  const configDir = (await safe(() => $.env.get('CLAUDE_CONFIG_DIR')))?.replace(/[\\/]+$/, '')
  const suffix = (await safe(() => $.env.get('CLAUDE_CODE_CUSTOM_OAUTH_URL'))) ? '-custom-oauth' : ''
  const dir = configDir || homeDir
  const current = dir ? `${dir}/.claude${suffix}.json` : null
  const legacyDir = configDir || (homeDir ? `${homeDir}/.claude` : null)
  const legacy = legacyDir ? `${legacyDir}/.config.json` : null
  const st = legacy ? await safe(() => $.fs.stat(legacy)) : undefined
  const isLegacy = st?.kind === 'file' && (st.size > 0 || !current || !(await safe(() => $.fs.stat(current))))
  configFile = isLegacy ? legacy : current
  return configFile
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
  if (mac !== undefined) return mac
  if (await isWindows($)) return (mac = false)
  return (mac = Boolean((await safe(() => $.fs.exists('/usr/bin/security'))) && (await safe(() => $.fs.exists('/System/Library/CoreServices')))))
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

// The keychain item's login; 'missing' when there is none (security exits 44), null when it
// could not be read (a locked keychain).
async function readKeychain($: EngineInterface): Promise<Record<string, unknown> | null | 'missing'> {
  const user = (await safe(() => $.env.get('USER'))) || 'claude-code-user'
  const service = await keychainService($)
  const r = await safe(() => $.process.run(['security', 'find-generic-password', '-a', user, '-w', '-s', service], { timeoutMs: 10_000 }))
  usesKeychain = r?.exitCode !== 44
  if (r?.exitCode === 44) return 'missing'
  if (!r || r.exitCode !== 0) return null
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

// The plan as people know it, from the login when ~/.claude.json has no planDisplayName.
// Claude Code itself counts a Team seat as Premium when its tier is default_claude_max_5x;
// a Team seat with any other tier is Standard.
function planName(subscriptionType: string | null, rateLimitTier: string | null): string | null {
  const sub = subscriptionType?.toLowerCase() ?? null
  const tier = rateLimitTier?.toLowerCase() ?? ''
  const multiplier = tier.match(/(\d+)x/)?.[1]
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
      return tier === 'default_claude_max_5x' ? 'Team Premium' : tier ? 'Team Standard' : 'Team'
    case 'enterprise':
      return 'Enterprise'
    default:
      return sub
        .split(/[_\s-]+/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')
  }
}

// Reads what changed since the last look and draws it. On an account switch the new
// account's name and email show at once; on macOS, where the plan is in the keychain, the
// plan follows when that read is back (the old account's is never shown meanwhile).
async function look($: EngineInterface): Promise<void> {
  const cfgPath = await configPath($)
  const credPath = await credentialsPath($)
  const cfgStamp = await stampOf($, cfgPath)
  const credStamp = await stampOf($, credPath)
  if (cfgStamp === configStamp && credStamp === credentialsStamp && account) return

  let oauth: Record<string, unknown> | null = null
  if (cfgPath && cfgStamp) {
    const cfg = await readJson($, cfgPath)
    // Half written, or over $.fs.read's limit for a moment: no switch, the next look tries again.
    if (!cfg) return
    oauth = isObject(cfg.oauthAccount) ? cfg.oauthAccount : null
  }
  configStamp = cfgStamp
  const uuid = str(oauth?.accountUuid)
  const isSwitch = tokensFor !== uuid

  if (credStamp !== credentialsStamp || isSwitch) {
    credentialsStamp = credStamp
    const fromFile = () => (credPath && credStamp ? readJson($, credPath) : Promise.resolve(null))
    // On macOS the login is in the keychain (a file beside it may be an old one), read only
    // on a switch, as it takes a process: draw the new account first, then its plan. Without
    // a keychain item Claude Code keeps it in the file, as on Linux and Windows.
    if (await isMac($)) {
      if (isSwitch) {
        tokens = null
        tokensFor = uuid
        if (uuid && !str(oauth?.planDisplayName)) {
          show($, uuid, oauth)
          const item = await readKeychain($)
          // The account changed again while the keychain was read: the next look has it.
          if (tokensFor !== uuid) return
          tokens = item === 'missing' ? tokensOf(await fromFile()) : tokensOf(item)
        }
      } else if (!usesKeychain) {
        tokens = tokensOf(await fromFile())
      }
    } else {
      tokens = tokensOf(await fromFile())
      tokensFor = uuid
    }
  }
  show($, uuid, oauth)
}

function show($: EngineInterface, uuid: string | null, oauth: Record<string, unknown> | null): void {
  const name = str(oauth?.displayName)?.split(/\s+/) ?? []
  const next: Account = {
    uuid,
    firstName: name[0] ?? null,
    lastName: name.length > 1 ? name.slice(1).join(' ') : null,
    email: str(oauth?.emailAddress),
    // What Claude Code shows as "Claude <planDisplayName>" (the server's own name for the
    // plan, kept in ~/.claude.json from the profile), else made from the login.
    plan: str(oauth?.planDisplayName) ?? (oauth ? planName(tokens?.subscriptionType ?? null, tokens?.rateLimitTier ?? null) : null),
  }
  if (JSON.stringify(next) === JSON.stringify(account)) return
  account = next
  refresh($)
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
    await look($)
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
  configFile = undefined
  mac = undefined
  usesKeychain = false
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
