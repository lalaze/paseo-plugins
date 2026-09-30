# paseo-provider-update

A **Provider updates** screen in Settings (also **Update providers** in the command center) that lists every provider enabled on the host, shows the installed and newest versions, and upgrades a provider's CLI with one click. Plugin ID: `paseo-provider-update`. It needs a Paseo daemon from 0.10 up to, but not including, 0.12.

```bash
paseo plugin add lalaze/paseo-plugins --path provider-update
```

From a local checkout, `cd provider-update && npm ci && npm run build` typechecks and writes `dist/`. Set `PASEO_COMPILER` to a Paseo checkout's `packages/server/dist/server/server/plugins/compiler.js` to run the host's import-boundary check as well.

## What gets updated

The plugin reads the daemon's own provider diagnostic (`paseo provider diagnostic <provider>`), so it upgrades the executable Paseo actually launches, including a configured command, and not whichever copy comes first on your shell's PATH. It follows symlinks and picks the updater that owns that file:

| Install | Recognised by | Update command | Newest version from |
| --- | --- | --- | --- |
| Claude Code native | `~/.local/share/claude/versions/…` | `claude update` | npm `@anthropic-ai/claude-code` |
| Codex standalone | `~/.codex/packages/standalone/…` | `codex update` | npm `@openai/codex` |
| Grok standalone | `~/.grok/downloads/…` | `grok update` | `grok update --check --json` |
| Kimi Code standalone | `~/.kimi-code/bin/…` | `kimi upgrade --yes` | Kimi's CDN `/latest`, for the region in `~/.kimi-code/region` |
| Global npm package | `<prefix>/lib/node_modules/<pkg>/…` | `<prefix>/bin/npm install --global <pkg>@latest` | npm `<pkg>` |
| Homebrew | `…/Cellar/<formula>/…`, `…/Caskroom/<cask>/…` | `brew upgrade [--cask] <name>` | none; the button stays available |

Grok's updater runs with `GROK_INSTALLER=internal`: left to itself, Grok can decide it came from npm and check a package that is not this build.

A provider whose configured command runs a script through an interpreter (`node hub.mjs run`) is listed as a local script, with the script's path and the version in its nearest `package.json` rather than the interpreter's. It has no update button; update it wherever the script came from.

Home directories that are symlinked elsewhere are matched both as written and as resolved. Anything else is listed as unrecognised, with its path, and must be updated by hand. The client only sends a provider name; the command is always one of the rows above, run without a shell.

## Limits

- One update runs at a time per host, with a 10-minute limit. The last 2,000 characters of its output are shown when it finishes.
- New sessions pick up the new version immediately. Agents that are already running keep the old binary until they restart.
- Versions are checked when the screen opens and cached for 10 minutes; **Check again** re-reads them. Newest versions for npm-fed rows come from `npm view`, so npm's registry, mirror and proxy settings apply.
- Claude's native updater follows its own release channel. If that is `stable`, it can stay behind npm's `latest` and the row keeps showing an update.
- Leaving the screen or unloading the plugin does not stop an update in progress; stopping npm or a self-updater midway can break the install.
- The plugin runs as the daemon user. A global npm prefix or Homebrew owned by another user fails with a permission error, which is shown on the row.
