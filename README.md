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

After an account switch (`/login` with another account, an account switcher such as
[claude-account-switcher](https://github.com/AlexCherrypi/claude-account-switcher)) the
line shows the new account within two seconds.

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
- **Plan**: `subscriptionType` and `rateLimitTier` of the login Claude Code keeps in
  `~/.claude/.credentials.json`, on macOS in the keychain item `Claude Code-credentials`
  (read only when the account changes). The tier names the multiplier (`Max 5x`,
  `Max 20x`) and, for Team and Enterprise, the seat (`Premium`, `Standard`) where it
  says one; otherwise just `Team` / `Enterprise` is shown.

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
