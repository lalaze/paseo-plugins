# paseo-shared-tools

A **Shared MCP & skills** screen in Settings (also in the command center) that gives every provider on a host one list of MCP servers and one skill library, so Claude Code, Codex, Grok, Kimi, CodeBuddy, Pi and the rest work with the same tools. Plugin ID: `paseo-shared-tools`. It needs a Paseo daemon from 0.10 up to, but not including, 0.12. Install it on each host separately.

```bash
paseo plugin add lalaze/paseo-plugins --path shared-tools
```

From a local checkout, `cd shared-tools && npm ci && npm run check` typechecks, runs the tests and writes `dist/`. Set `PASEO_COMPILER` to a Paseo checkout's `packages/server/dist/server/server/plugins/compiler.js` to run the host's import-boundary check as well.

## MCP servers

Shared servers are added to each new agent as Paseo creates it, through the same `mcpServers` field Paseo uses for its own tools. Paseo translates them for each provider: Claude's SDK options, Codex's `mcp_servers`, OpenCode, ACP sessions (Grok, Kimi, CodeBuddy, Copilot, Antigravity Hub, …) and Pi's MCP adapter. No CLI's own config file is changed, so agents started outside Paseo do not see them.

- Add a server by hand (stdio command, or an HTTP/SSE URL with headers), paste an `mcpServers` object in the format Claude Code, Cursor and Gemini use, or import Claude Code's user servers (`~/.claude.json`) or Codex's (`codex mcp list --json`). Servers switched off in Codex are not imported; one that reads its token from `bearer_token_env_var` is skipped, since Paseo can only pass literal headers.
- A server can be switched off, or limited to some providers.
- Each provider has an **MCP** switch. Pi starts with it off: Pi only runs MCP servers with the `pi-mcp-adapter` extension, and Paseo refuses to start an agent whose provider cannot run the servers it is given. Turn it on once the adapter is installed.
- A server the agent was created with under the same name (by a schedule, a delegation or another plugin) is kept as given. The names `paseo` and `director` belong to Paseo and are never used.
- Only new agents get the servers. Agents that are already running, and resumed agents, keep the servers they were created with.

## Skills

The library is `$PASEO_HOME/shared-tools/skills` (by default `~/.paseo/shared-tools/skills`); each skill is a folder with a `SKILL.md`, as every one of these CLIs expects. Each skill is copied into the user-level skills folder of every provider with **Skills** on:

| Provider | Folder |
| --- | --- |
| Claude Code | `~/.claude/skills` |
| Codex | `~/.codex/skills` |
| Grok | `~/.grok/skills` |
| Kimi Code | `~/.kimi-code/skills` |
| CodeBuddy | `~/.codebuddy/skills` |
| Pi | `~/.pi/agent/skills` |
| OpenCode | `~/.config/opencode/skills` |
| Copilot | `~/.copilot/skills` |
| Gemini | `~/.gemini/skills` |
| Cursor | `~/.cursor/skills` |

A custom provider is matched by its id, then by the executable it runs (`kimi acp` → Kimi Code). For any other provider, set a folder on its row. Providers that share a folder are synced once.

- **Getting started:** the screen lists skills it finds in the providers' folders. **Add to library** copies one in; any other folder from disk can be added by path. The provider's own copy, being identical, is adopted rather than duplicated.
- **Editing:** edit the files in the library. Changes reach every provider within a couple of seconds, or on **Sync now**.
- **Ownership:** every copy has a `.paseo-shared-tools.json` manifest. The plugin only updates or removes copies with a manifest that have not been edited since it wrote them. A skill of your own with the same name shows as **name taken**, and a copy edited in a provider's folder shows as **edited there**; both are left alone until you choose **Replace**, which first moves the existing copy to `~/.paseo/shared-tools/backups`.
- **Removing:** removing a skill moves it from the library to the backups and removes the untouched copies. Switching **Skills** off for a provider removes the plugin's untouched copies from its folder.
- Skills are copied, not linked, since not every CLI follows links. A link you made yourself from a provider's folder into the library counts as in sync.

## Files

Everything lives in `$PASEO_SHARED_TOOLS_DIR`, or `$PASEO_HOME/shared-tools`:

- `config.json`: the shared servers in the usual `mcpServers` format, plus `enabled: false` and `providers: [...]` where set, and the per-provider switches. It may hold tokens, so it is written with mode 600. You can edit it by hand; an entry the plugin cannot read is reported on the screen and kept.
- `skills/`: the library.
- `backups/`: replaced copies and removed library skills.

## Limits

- The plugin runs as the daemon user and writes only to the skills folders above and its own folder.
- Skills are user-level only; project folders such as `.claude/skills` in a repository are not touched.
- The library is watched for changes while the daemon runs. Changes made while it is stopped are applied at the next start.
