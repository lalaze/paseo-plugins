# paseo-plugins

Multi-package repository of Paseo plugins and companion extensions. Enable plugins under **Settings → Plugins** on the target host first. Each package can also be installed on its own as described below; see each directory's README for updating, uninstalling and limitations.

Install everything at once (five plugins, the quota patch, Kimi renewal and the Hub ACP):

```bash
./install-all.sh
```

By default this installs from the local checkout, so keep this directory around. `--git` installs the plugins from GitHub instead; `--replace` removes the old single-repo sources before installing; `--dry-run` only previews. `--skip-quota` / `--skip-kimi` / `--skip-hub` skip the corresponding items.

Update everything that is installed:

```bash
./update-all.sh
```

This runs `git pull`, then updates every item that was installed from this repo. Items that are not installed are skipped. `--skip-pull` updates without pulling.

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

## [AI collaboration (Director)](director)

Pick the design, implementation and review AIs yourself, and run design, implementation, review and acceptance as a collaboration. Plugin ID: `paseo-director`.

```bash
paseo plugin add lalaze/paseo-plugins --path director
```

Details: [director/README.md](director/README.md)

## [Usage Glance](usage-glance)

Shows a quota summary and breakdown for the current host in the top-right corner of the workspace, with providers pinnable to the top bar. The "Token usage" sidebar entry opens a standalone statistics page with multi-host totals, per-host filtering and a monthly model heatmap; common ranges refresh in the background every minute and cached data is shown first when opened. Usage follows each host's own Providers toggles and supports Codex, Claude Code, Kimi, Grok, Antigravity and Pi, grouped by provider, model, model vendor or host. Install or update it on each host separately. Plugin ID: `paseo-usage-glance`. Antigravity quota additionally requires the [`agy-quota`](agy-quota) patch below.

```bash
paseo plugin add lalaze/paseo-plugins --path usage-glance
```

Details: [usage-glance/README.md](usage-glance/README.md)

## [Response Speed](response-speed)

After every AI reply, shows that provider / model's generation speed (t/s), output tokens, time to first token (TTFT), overall speed and total duration. Only provider-reported tokens are used; nothing is guessed from character counts. Plugin ID: `paseo-response-speed`.

```bash
paseo plugin add lalaze/paseo-plugins --path response-speed
```

Details: [response-speed/README.md](response-speed/README.md)

## [File Transfer](file-upload)

A workspace file transfer panel: browse the directory tree and upload/download files on the current daemon host. Plugin ID: `paseo-file-upload`.

```bash
paseo plugin add lalaze/paseo-plugins --path file-upload
```

Details: [file-upload/README.md](file-upload/README.md)

## [Selection Translate](translate)

Select text in a user message or AI reply and translate it in place through a custom OpenAI-compatible translation API, with the result copied; no local agent is created and the chat history is left untouched. Plugin ID: `paseo-translate`.

```bash
paseo plugin add lalaze/paseo-plugins --path translate
```

Details: [translate/README.md](translate/README.md)

## [Antigravity quota patch](agy-quota)

Adds Google Antigravity quota reading to Plan usage, plus optional on-demand Kimi renewal. This is an install-time patch, not a `paseo plugin` package.

```bash
git clone git@github.com:lalaze/paseo-plugins.git
cd paseo-plugins
node patch.mjs check && node patch.mjs apply
paseo daemon restart
```

The scripts live in [`agy-quota/`](agy-quota). The root-level `patch.mjs` / `kimi-patch.mjs` forward to that directory, and the old `node patch.mjs rollback` still works.

Details: [agy-quota/README.md](agy-quota/README.md)

## [Antigravity Hub ACP](antigravity-hub)

Connects the local Antigravity Hub to Paseo ACP, with model selection, streaming replies, tool progress and Plan mode. This is an ACP provider, not a `paseo plugin` package.

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

- `paseo-sub-agnet` → [Director](director/README.md)
- `paseo-agy-quote` → [Usage Glance](usage-glance/README.md), [quota patch](agy-quota/README.md), [Hub ACP](antigravity-hub/README.md)
- `paseo-file-upload` → [File Transfer](file-upload/README.md)

## Mobile runtime regression check

The client state of Director and Usage Glance is built with factory functions. When Hermes evaluates the esbuild output dynamically, instantiating anonymous classes can fail with `Cannot read property 'prototype' of undefined`, so dynamic loading must be verified even after the Node tests pass.

Install the dev dependencies of both plugins, get the [official Hermes CLI](https://github.com/facebook/hermes/releases/tag/v0.13.0), and run from the repo root:

```bash
HERMES_BIN=/path/to/hermes node scripts/check-mobile-runtime.mjs
```

The check loads the compiled output through `eval` and verifies creation and cleanup of collaboration requests, draft writes and multi-host registration state. RPC, schema and query-cancellation detection use stubs; the mobile UI still needs verification on a real device.
