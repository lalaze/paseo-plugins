# paseo-shared-tools

A **Shared MCP & skills** page in the app's left sidebar, also available in Settings (the plugin's **…** menu), as a panel in each workspace's explorer next to Files and Changes and from the command center, that gives every provider on a host one list of MCP servers and one skill library, so Claude Code, Codex, Grok, Kimi, CodeBuddy, Pi and the rest work with the same tools. It also lets one host share its MCP servers with other machines through a small authenticated gateway (see **Multi-machine** below). Plugin ID: `paseo-shared-tools`. It needs a Paseo daemon from 0.10 up to, but not including, 0.12. Install it on each host separately.

```bash
paseo plugin add git:lalaze/paseo-plugins --path shared-tools
```

From a local checkout, `cd shared-tools && npm ci && npm run check` typechecks, runs the tests and writes `dist/`. Set `PASEO_COMPILER` to a Paseo checkout's `packages/server/dist/server/server/plugins/compiler.js` to run the host's import-boundary check as well.

## MCP servers

Shared servers are added to each new agent as Paseo creates it, through the same `mcpServers` field Paseo uses for its own tools. Paseo translates them for each provider: Claude's SDK options, Codex's `mcp_servers`, OpenCode, ACP sessions (Grok, Kimi, CodeBuddy, Copilot, Antigravity Hub, …) and Pi's MCP adapter. No CLI's own config file is changed, so agents started outside Paseo do not see them.

- Add a server by hand (stdio command, or an HTTP/SSE URL with headers), paste an `mcpServers` object in the format Claude Code, Cursor and Gemini use, or import Claude Code's user servers (`~/.claude.json`) or Codex's (`codex mcp list --json`). Servers switched off in Codex are not imported; one that reads its token from `bearer_token_env_var` is skipped, since Paseo can only pass literal headers.
- Each server's **Provider permissions** button (people icon), also available in its add/edit form, offers **Allow all**, **Allowlist**, and **Denylist**. An allowlist permits only the selected providers; an empty allowlist permits nobody. A denylist excludes the selected providers and allows the rest, including future providers. An empty denylist allows everyone. The provider's **MCP** switch must also be on. Existing configurations keep their original behavior.
- Each provider has an **MCP** switch. Pi starts with it off: Pi only runs MCP servers with the `pi-mcp-adapter` extension, and Paseo refuses to start an agent whose provider cannot run the servers it is given. Turn it on once the adapter is installed.
- A server the agent was created with under the same name (by a schedule, a delegation or another plugin) is kept as given. The names `paseo` and `director` belong to Paseo and are never used.
- Only new agents get the servers. Agents that are already running, and resumed agents, keep the servers they were created with.

### Signing in

An http or sse server without an `Authorization` header gets a **Find authorization / sign in** button. It first looks for existing MCP OAuth authorization on the daemon host, matches the full server URL (not its display name), and verifies the access token against that server. A successful match shows **via Codex**, **via Claude Code** or **via Kimi** and needs no browser or new client registration. Every provider then gets the token as an `Authorization` header.

- Supported file caches: Codex's `~/.codex/.credentials.json`, Claude Code's `~/.claude/.credentials.json` (`mcpOAuth`), and Kimi CLI's FastMCP `mcp-oauth` store under `~/.kimi-code` or `~/.kimi`. OS keychains, custom data directories and other cache formats are not scanned. An LLM-provider login is not an MCP authorization.
- Reused authorization stays owned by its original client. Only the source and MCP URL are saved in the plugin; access and refresh tokens are not copied. The page and new agents read the source again, picking up native refreshes and sign-outs. The plugin does not refresh borrowed tokens, avoiding conflicts with rotating refresh tokens. If the source token expires, authorize that MCP again in the original client and retry. Existing agents still keep their original token.
- Expired or unverifiable matches produce a message naming the client. **Browser sign-in** bypasses the cache search when you want a separate authorization. This is also useful for servers that permit registration; some, including Figma's remote MCP, restrict which clients may register.
- **Authorize with Codex** asks the real Codex CLI to obtain a new authorization for an HTTP server. The host needs `codex` on its PATH with `mcp login --no-browser` support. The plugin passes temporary MCP settings without editing `config.toml`, opens the authorization link on the app device, and submits the pasted full callback URL to the CLI. Even if the callback page cannot load, its address can be pasted. After Codex saves the credential, the plugin verifies and links it. Cancel, timeout and plugin reload terminate the pending CLI process. This uses Codex's file credential store under `~/.codex` so the shared plugin can read it; no Codex account/model session is started.

When no saved authorization is found, the plugin signs in once on the host, the MCP way: it reads the server's protected resource metadata, registers itself with the authorization server, and uses PKCE.

- The approval page opens in the browser of the device running the app, even when the daemon is on another machine.
- Afterwards the browser goes to `http://localhost:47821/callback`. On the host itself, or with the port forwarded (`ssh -L 47821:localhost:47821 host`), the plugin catches that page and finishes the sign-in by itself. Otherwise, such as over plain SSH or from a phone, that page does not load: copy its address from the address bar and paste it into the form.
- Tokens are kept in `oauth.json` (mode 600) and refreshed when a new agent starts close to expiry. An agent keeps the token it was started with, so a long-running agent may need restarting once its token expires.
- A server with its own `Authorization` header uses that header and shows no button. Servers whose authorization server does not let apps register themselves (dynamic client registration) cannot sign in this way; give them a token header.

## Skills

The library is `$PASEO_HOME/shared-tools/skills` (by default `~/.paseo/shared-tools/skills`); each skill is a folder with a `SKILL.md`, as every one of these CLIs expects. Each skill is copied into the user-level skills folder of each allowed provider with **Skills** on:

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

- **Provider permissions:** each library skill has the same **Allow all / Allowlist / Denylist** controls as MCP servers. Saving applies the rule immediately and removes untouched managed copies from denied providers. Edited copies and independent skills or links remain, with a note explaining that they are still on disk; these rules control plugin sharing rather than a CLI's independently installed tools. If providers share a folder but have different effective permissions, the skill is withheld from that folder and a warning asks you to set separate folders. The plugin removes its untouched copy there to prevent sharing through the common folder.
- **Getting started:** the screen lists skills it finds in the providers' folders. **Add to library** copies one in; any other folder from disk can be added by path. The provider's own copy, being identical, is adopted rather than duplicated.
- **Editing:** edit the files in the library. Changes reach every provider within a couple of seconds, or on **Sync now**.
- **Ownership:** every copy has a `.paseo-shared-tools.json` manifest. The plugin only updates or removes copies with a manifest that have not been edited since it wrote them. A skill of your own with the same name shows as **name taken**, and a copy edited in a provider's folder shows as **edited there**; both are left alone until you choose **Replace**, which first moves the existing copy to `~/.paseo/shared-tools/backups`.
- **Removing:** removing a skill moves it from the library to the backups and removes the untouched copies. Switching **Skills** off for a provider removes the plugin's untouched copies from its folder.
- Skills are copied, not linked, since not every CLI follows links. A link you made yourself from a provider's folder into the library counts as in sync.

## Multi-machine: sign in once, use it everywhere

One host — the **center** — can run a small authenticated MCP gateway. Sign in to an MCP server once there, create a device credential for another machine, and that machine's new agents reach the same server through the center, under the center account's permissions. The center's upstream token never leaves the center; a device only ever holds its own revocable token. **One token can be authorized for several providers**, so you do not open one per provider. The gateway is **off by default**.

**On the center host**

1. Open the **Machines** tab and switch **Center gateway** on. It binds `0.0.0.0:47822` by default, and the address other machines use is `http://100.96.195.115:47822`; change it if this host's private-network address differs. Plain HTTP is for Tailscale or another trusted private network — put HTTPS in front of it for the public internet.
2. **Create device**, tick every provider the device may run as (**Select all** / **Clear** help), and limit it to some servers if you like. The token is shown **once**: copy it now. Only its hash is stored and it cannot be shown again; if it is lost, revoke the device and create another.
3. Add the servers to share on the **MCP servers** tab. Only enabled **http** servers are shared; older **sse** and local **stdio** servers stay on this machine and are listed as not shared. Each server's **Provider permissions** and each provider's **MCP** switch both still apply, per provider.
4. Change a device's providers later with its **Edit providers** button. The token stays the same. Removing a provider takes effect at once: that provider's running calls are cut and its sessions are refused; the remaining providers keep working.

**On the other machine**

1. Install this plugin there too, open the **Machines** tab, and **Connect** with the center URL and the device token. Tick the providers this token is authorized for on the center; one connection is saved per provider with the same token. A provider the center does not allow is saved as an error row and is not added to agents.
2. New agents of each connected provider get that provider's view of the center's servers; the caller's own same-named servers and this host's own servers keep priority. The center must be online — if it is not, the page shows the failure and **no** gateway servers are added, rather than serving a stale copy.
3. **Revoke** a device on the center to stop it at once; its live calls are cut. **Check now** refreshes a connection's catalog.

Each request names the provider it acts as in an `X-Paseo-Provider` header, so one token's providers never share permissions or sessions. A client outside Paseo uses the same endpoints with the device token and that header:

```json
{ "mcpServers": { "docs": { "type": "http", "url": "http://100.96.195.115:47822/mcp/docs", "headers": { "Authorization": "Bearer <device token>", "X-Paseo-Provider": "claude" } } } }
```

`GET /v1/servers` lists the servers a token may use for the provider named in `X-Paseo-Provider`, and answers with that provider. A credential authorized for one provider may omit the header; a multi-provider credential must send it (otherwise `400`), and an unauthorized provider is refused (`403`). The MCP Streamable HTTP methods are proxied, including SSE responses; redirects are refused, the request body is size-limited, and each device's sessions are kept separate per server **and** per provider. The provider header stays on this host — it is never forwarded upstream.

## Files

Everything lives in `$PASEO_SHARED_TOOLS_DIR`, or `$PASEO_HOME/shared-tools`:

- `config.json`: the shared servers in the usual `mcpServers` format, plus `enabled: false`, `providers: [...]` (allowlist), and `excludedProviders: [...]` (denylist) where set, the per-provider switches, and `skillAccess` rules keyed by skill name with the same permission fields. Missing/null `providers` allows everyone; `providers: []` allows nobody. Denials take precedence if both lists are hand-edited. These metadata fields are never passed to MCP clients. It may hold tokens, so it is written with mode 600. You can edit it by hand; an entry the plugin cannot read is reported on the screen and kept. Invalid permission rules stop sharing the affected resource rather than allowing everyone.
- `oauth.json`: sign-ins, by server name (clients, access and refresh tokens for browser sign-ins; source references for reused native authorization), mode 600.
- `gateway.json`: the multi-machine gateway's own settings, device token **hashes** with the providers each is authorized for, and connections to other centers (one row per provider), mode 600. A legacy single-provider device row is read as `providers: [provider]`; a row whose `providers` is present but empty or malformed is ignored rather than widened. Kept apart from `config.json` and `oauth.json` so a hand-edited server list and this file never race.
- `skills/`: the library.
- `backups/`: replaced copies and removed library skills.

## Limits

- The plugin runs as the daemon user and writes only to the skills folders above and its own folder.
- Skills are user-level only; project folders such as `.claude/skills` in a repository are not touched.
- The library is watched for changes while the daemon runs. Changes made while it is stopped are applied at the next start.
- The multi-machine gateway shares only enabled **http** MCP servers. Older **sse** and local **stdio** servers are not reachable from other machines.
- Other machines depend on the center being online and authorized. A borrowed authorization is refreshed by the client that owns it, so if the center's borrowed token expires, re-authorize that MCP on the center and retry; the center does not take over the login.
- The gateway is off by default and listens only while it is switched on. Revoking a device credential stops its calls immediately.
