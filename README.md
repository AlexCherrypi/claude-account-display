# account-display

Claude Code plugin that shows who is signed in, in one line: the account owner's first
and last name, the email address and the full plan, separated by dots:

```
Alex Cherry · alex@example.com · Team Premium
```

The line goes either in the status line under the prompt (`bottom`, the default) or in a
row above the prompt (`top`). Above the prompt it sits over whatever another plugin draws
there (e.g. [limit-bars](https://github.com/AlexCherrypi/limit-bars)), as long as that
plugin passes the band on.

**After an account switch** (`/login` with another account, an account switcher such as
[claude-account-switcher](https://github.com/AlexCherrypi/claude-account-switcher)) the
line shows the new account at once, as limit-bars does: every second it looks at
`oauthAccount.accountUuid` in `~/.claude.json` (a `stat`, read only when it changed) –
or wherever Claude Code keeps it: `$CLAUDE_CONFIG_DIR/.claude.json`, an older install's
`.config.json`, `.claude-custom-oauth.json` with `CLAUDE_CODE_CUSTOM_OAUTH_URL`. A file
that is half written for a moment is no switch. On macOS the new name and email show
right away and the plan follows as soon as the keychain has answered; the old account's
plan is never shown beside the new account.

## Options

In `/plugin` → account-display → configure:

| Option | Default | What |
|---|---|---|
| `position` | `bottom` | `bottom` = status line under the prompt, `top` = row above the prompt |
| `firstName` | on | the owner's first name |
| `lastName` | on | the owner's last name |
| `email` | on | the account's email address |
| `plan` | on | the full plan: `Free`, `Pro`, `Max 5x`, `Max 20x`, `Team Standard`, `Team Premium`, `Enterprise` … |

## Where the figures come from

- **Name and email**: `oauthAccount.displayName` and `oauthAccount.emailAddress` in
  `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`). The first word of the display
  name is taken as the first name, the rest as the last name.
- **Plan**: `oauthAccount.planDisplayName` in the same file – the plan's name as Claude
  Code itself shows it (`Claude <planDisplayName>`), taken from the account's profile.
  Where an older record has none, the plan is made from `subscriptionType` and
  `rateLimitTier` of the login Claude Code keeps in `~/.claude/.credentials.json`, on
  macOS in the keychain item `Claude Code-credentials` (read only when the account
  changes; a `.credentials.json` beside it is used only where the keychain has no item):
  `max` with `default_claude_max_5x` / `_20x` is `Max 5x` / `Max 20x`; `team` with
  `default_claude_max_5x` is `Team Premium` (as Claude Code counts it), with another tier
  `Team Standard`.

The plugin only reads; the tokens in the login are never used or sent anywhere.

## Install

```
/plugin marketplace add AlexCherrypi/claude-account-display
/plugin install account-display@account-display
```

## Develop

```
claude plugin validate .
claude plugin test .
```
