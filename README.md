# paseo-plugins

Multi-package repository of Paseo plugins and companion extensions. Plugin manifests use `requirements.paseo: "*"` so daemon and app upgrades, including prereleases, do not block loading by version number. Keep this field explicit: Paseo interprets a missing requirement as a legacy pre-0.8 plugin. The separate quota and notification patches retain their own version restrictions. Enable plugins under **Settings → Plugins** on the target host first. Each active package can also be installed on its own as described below; see each directory's README for updating, uninstalling and limitations.

Run `node scripts/check-plugin-requirements.mjs` to check every manifest against the installed Paseo compatibility validator for both daemon and app, including 0.12.0 and future versions. Pass an optional absolute CLI package directory to use a different Paseo installation. Git installations have separate checkouts: after this change is published, run `paseo plugin update <id>` to obtain it; local installations need `paseo plugin reload <id>`.

Install the active packages at once (three plugins and Kimi renewal):

```bash
./install-all.sh
```

By default this installs from the local checkout, so keep this directory around. `--git` installs the plugins from GitHub instead; `--replace` removes the old single-repo sources before installing; `--dry-run` only previews. `--skip-kimi` skips Kimi renewal. The old Antigravity quota patch and Hub are retained as source only; install, update, and the CLI wrapper do not load the quota patch or register the Hub provider. `--skip-quota` and `--skip-hub` remain accepted for older commands.

Update the active packages that are installed:

```bash
./update-all.sh
```

This runs `git pull`, then updates active items that were installed from this repo. Items that are not installed are skipped. `--skip-pull` updates without pulling. The archived `director/`, `file-upload/` and `response-speed/` sources are retained, but neither script installs, updates, or individually reloads these plugins, even if they are already installed. Usage Glance provides token consumption statistics only; account quotas use Paseo's official feature.

On macOS `~/.local/bin` is not on the PATH by default, and nvm gets ahead of it. Set up the wrapper like this:

```bash
mkdir -p ~/.local/bin
ln -sfn "$PWD/agy-quota/bin/paseo" ~/.local/bin/paseo
export PATH="$HOME/.local/bin:$PATH"
```

Put `export PATH="$HOME/.local/bin:$PATH"` in `~/.zshrc` **after** the nvm initialization. Don't use `readlink -f` (BSD has no `-f`); use this instead:

```bash
node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$(which paseo)"
```

It should print `.../paseo-plugins/agy-quota/bin/paseo`.

Plugins and patches run with the daemon user's privileges; read the source in the corresponding directory before installing.

## [Token Usage](usage-glance)

The top-right **Today** indicator shows multi-host daily token consumption, with green (<1B), yellow (1B–5B) and red (≥5B) status colors; click it to open the **Token Usage** sidebar page with provider/workspace/model breakdowns and a monthly heatmap on desktop and mobile. Common ranges refresh every minute. Plugin ID: `paseo-usage-glance`. Quota queries are disabled; use Paseo's official quota feature for account limits. Install or update on each host to include its records.

```bash
paseo plugin add git:lalaze/paseo-plugins --path usage-glance
```

Details: [usage-glance/README.md](usage-glance/README.md)

## [Dot Bridge](dot-bridge)

Chat with your connected ChatGPT Dot in Paseo and apply requested changes to the host's workspace. Plugin ID: `paseo-dot-bridge`. Install separately on each Paseo host, including the `code` machine; `install-all.sh` and `update-all.sh` do not manage it. Requires Node.js 22.13+ with Paseo plugins enabled.

```bash
paseo plugin add git:lalaze/paseo-plugins --ref main --path dot-bridge
paseo plugin reload paseo-dot-bridge
```

Details, updates and connecting another machine to the existing Dot: [dot-bridge/README.md](dot-bridge/README.md#install-on-another-host-code)

## [Magpie](magpie)

Manage Magpie from Paseo's sidebar using native plugin components: Agents, sessions, library,
providers, routing, gateway, usage, plugins and settings. The daemon calls Magpie's authenticated
API; no embedded browser or custom Paseo client is needed. Plugin ID: `magpie`. Install separately;
`install-all.sh` and `update-all.sh` do not manage it.

```bash
paseo plugin add git:lalaze/paseo-plugins --path magpie
```

Details: [magpie/README.md](magpie/README.md)

## [Tasks](todo)

Queues tasks in the sidebar, with a per-project **Tasks** panel in each workspace's explorer. Each task runs in its own git worktree, and a person accepts the result before it merges into the chosen branch. Closing the sidebar does not stop the queue. Plugin ID: `paseo-todo`. It is a separate install: `install-all.sh` and `update-all.sh` do not install or update it.

```bash
paseo plugin add git:lalaze/paseo-plugins --path todo
```

Details: [todo/README.md](todo/README.md)

## [Provider updates](provider-update)

A **Provider updates** screen in Settings lists the providers enabled on the host, with installed and newest versions, and upgrades a provider's CLI with one click. It targets the executable the daemon actually launches and uses a fixed updater per install type (Claude native, Codex, Grok and Kimi Code standalone, global npm, Homebrew); a script run through node or another interpreter is listed with its own version. Plugin ID: `paseo-provider-update`. It is a separate install: `install-all.sh` and `update-all.sh` do not install or update it.

```bash
paseo plugin add git:lalaze/paseo-plugins --path provider-update
```

Details: [provider-update/README.md](provider-update/README.md)

## [Shared MCP & skills](shared-tools)

A **Shared MCP & skills** screen in Settings gives every provider on a host one list of MCP servers and one skill library. Shared servers are added to each new agent through Paseo's own `mcpServers` path, so Claude Code, Codex, OpenCode and the ACP providers all get them without any CLI config being edited; Pi joins once its MCP adapter is installed. Skills live in one library and are copied into each CLI's own skills folder (`~/.claude/skills`, `~/.codex/skills`, `~/.grok/skills`, `~/.kimi-code/skills`, …). Copies you edited, and skills of your own with the same name, are never overwritten without asking. Servers can be imported from Claude Code, Codex or pasted JSON, and existing skills from any provider's folder. Plugin ID: `paseo-shared-tools`.

```bash
paseo plugin add git:lalaze/paseo-plugins --path shared-tools
```

Details: [shared-tools/README.md](shared-tools/README.md)

## [Pi Qwen thinking levels](pi-qwen-thinking)

A Pi companion extension that forwards the selected thinking strength to the
local Qwen3.8-Flash-Next model. It maps Minimal/Low to `low`, Medium to `medium`,
and High/Extra High to `xhigh`; Off disables thinking. Install separately on
each Pi host (this is not part of `install-all.sh`):

```bash
node pi-qwen-thinking/install.mjs
```

Details: [pi-qwen-thinking/README.md](pi-qwen-thinking/README.md)

## [File Transfer — archived source](file-upload)

The local source for the former workspace file transfer panel is preserved in `file-upload/` for reference. Plugin ID: `paseo-file-upload`. It is no longer part of the installation, update, or migration workflow; do not install it as part of repository setup.

Details: [file-upload/README.md](file-upload/README.md)

## [Selection Translate](translate)

Select text in a user message or AI reply and translate it in place through a custom OpenAI-compatible translation API; no local agent is created and the chat history is left untouched. On iOS/Android a native "Translate" pill next to the composer translates a draft for sending or copying, or translates the latest AI reply. A [companion app patch](translate/README.md#手机端每条回复下方的翻译按钮) adds a button below each completed AI reply to expand or collapse its Chinese translation. Plugin ID: `paseo-translate`.

```bash
paseo plugin add git:lalaze/paseo-plugins --path translate
```

Details: [translate/README.md](translate/README.md)

## [Antigravity quota patch — archived source](agy-quota)

The old Google Antigravity quota reader is retained for reference. Use the official Antigravity provider. Install, update, and CLI startup do not apply this patch. Kimi and Grok renewal remain independent. The commands below are only for explicitly restoring the old patch.

```bash
git clone git@github.com:lalaze/paseo-plugins.git
cd paseo-plugins
node patch.mjs check && node patch.mjs apply
paseo daemon restart
```

The scripts live in [`agy-quota/`](agy-quota). The root-level `patch.mjs` / `kimi-patch.mjs` forward to that directory, and the old `node patch.mjs rollback` still works.

Details: [agy-quota/README.md](agy-quota/README.md)

## [Antigravity Hub ACP](antigravity-hub)

Retained for reference and manual use. Its provider entry is no longer registered by `install-all.sh` or `update-all.sh`; use the regular Antigravity provider in Paseo. The commands below explicitly restore the optional Hub ACP entry.

```bash
git clone git@github.com:lalaze/paseo-plugins.git
cd paseo-plugins
node hub.mjs check && node hub.mjs install
paseo reload
```

The scripts live in [`antigravity-hub/`](antigravity-hub). The root-level `hub.mjs` forwards to that directory.

Details: [antigravity-hub/README.md](antigravity-hub/README.md)

## Migrating from the old repositories

The former single-purpose repositories were merged here by directory. On hosts where they are installed, remove the old sources first, then install with the commands above:

- `paseo-agy-quote` → [quota patch](agy-quota/README.md), [Hub ACP](antigravity-hub/README.md). [Token Usage](usage-glance/README.md) retains consumption statistics under the existing plugin ID; use Paseo's official quota feature for limits.

AI collaboration has moved into Paseo itself. The former `paseo-sub-agnet` / `paseo-director` plugin is [archived source](director/README.md); use the built-in feature instead of reinstalling it. Disable the old plugin before enabling built-in collaboration, and retain `$PASEO_HOME/director` (or `PASEO_DIRECTOR_DATA_DIR`) for migration.

The former `paseo-file-upload` repository is preserved as [archived source](file-upload/README.md) only; it does not need to be migrated or reinstalled.

## Mobile runtime regression check

The check covers Token Usage's multi-host state and Translate's native reply registration and long-reply splitting. Dynamic loading in Hermes must be verified even after the Node tests pass.

Install Usage Glance's and Translate's dev dependencies, get the [official Hermes CLI](https://github.com/facebook/hermes/releases/tag/v0.13.0), and run from the repo root:

```bash
HERMES_BIN=/path/to/hermes node scripts/check-mobile-runtime.mjs
```

The check loads the compiled output through `eval` and verifies multi-host registration, reply translations and cleanup. RPC, schema and query-cancellation detection use stubs; the mobile UI still needs verification on a real device.
