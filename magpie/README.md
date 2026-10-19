# Magpie in Paseo

A native Magpie management interface in Paseo's sidebar. Uses Paseo's existing React Native
plugin components and the authenticated API of Magpie running on the daemon host. Works with
the released Paseo 0.11.1 client; it does not require WebFrame, an iframe or a custom Paseo build.

The interface follows Magpie Web's palette, grouped sidebar, compact header, rounded lists,
model selectors and switches. Light/dark appearance follows Paseo. Narrow layouts put navigation
across the top and model controls below each Agent. Bundled icon assets are credited in
`THIRD_PARTY_NOTICES`.

Provider details, account/model management and add/edit forms open in Paseo's adaptive modal
(a centered dialog on desktop and a sheet on mobile). Action feedback remains visible inside it.

## Native pages and operations

| Page      | Implemented controls                                                                                                                                                                                                                                                                                                                      |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents    | Scan, connect/disconnect, model/effort selection, profiles, arrangement/visibility, model visibility/order, config preview, CLI versions/update/install commands, Codex daemon restart                                                                                                                                                    |
| Sessions  | History/transcripts, content search, Agent/folder filtering, selected deletion, trash restore/purge, export, recording, Claude relocation preview/confirmation, Codex provider migration                                                                                                                                                  |
| Library   | Instructions and sets, MCP editing/discovery/check/OAuth status/cancel, project MCP config export, skill install/probe/update/import/group/discovery, Hooks and subagents, RTK, projects, resource markets with native input fields                                                                                                       |
| Providers | API and Remote magpie providers, built-in and plugin sign-in, saved account controls/import/aliases/order, routing/affinity/keep-login/switch-only, model restrictions/caps/concurrency/proxies, key rename/weight/protocol/replacement, API detection/tests/balance, per-model names/efforts/images/API/context/output/compaction/prices |
| Routing   | Group/member/strategy management, live and historical decisions, account pools, native rule conditions/order/removal, weights/manual pick/affinity/timeouts/patterns, templates/import/share/order, rest clearing                                                                                                                         |
| Gateway   | Sharing and key lifecycle, custom keys, model/account permissions, quota visibility, up to five separately editable budget windows and per-window resets, connection examples, explicit call inspection, S3 archive controls/read/export, restart/takeover                                                                                |
| Usage     | Overview, requests/filtering/pagination/custom date ranges/CSV export/content, trend and activity charts, account/key/model/provider breakdown data, session analysis/filtering/rankings, context curves, optimization apply/undo, quota refresh/reset/history                                                                            |
| Plugins   | Discovery/install/enable/update/remove, update checks, mirror, options/diagnostics, sign-in questionnaires, declared switches, custom-page options and allowed data reads                                                                                                                                                                 |
| Settings  | All eight sections have native entries: general, allowances, network/sharing, models/search, privacy, observability, sync/backup, about/update/CLI                                                                                                                                                                                        |

The controls call the authenticated Magpie API on the selected Paseo host. Native and original
Magpie changes share the same configuration. Writes are serialized; long operations report jobs.
Destructive actions request confirmation, including trash purge, backup import and migration.

## Coverage and verification — 2026-10-18

The baseline is the installed **Magpie 0.1.1283** service. Its served `index.html`, `app.js`,
gateway/library/routing/sessions/usage modules, `plugins.js`, `pluginpages.js` and `context.js`
were inspected directly. Official source was used to check request types, dedicated settings
endpoints and replacement/merge behavior. Read-only checks against this host's real service
verified the shapes of providers, groups, library, gateway keys, context, session overview,
plugins and sync responses. Account switching, deletion, quota reset and backup restore were
not exercised against live data.

Validation includes TypeScript and **81 passing tests** across five files, plus desktop and
390-pixel browser checks using the native component preview. Tests cover, among other things,
MCP authorization/cancel, per-window budgets, filtered export, native rules, model preferences,
Agent arrangement, restore confirmation and credential preservation.
Browser layout checks use fixture data; actual iOS/Android device validation is still pending.

This is **not a claim of complete UI parity**. The remaining differences are explicit:

- Arbitrary community plugin HTML/JavaScript pages and inline panels do not execute in Paseo's
  native runtime. Their options and declared read operations are accessible; this does not
  reproduce their custom interactions or add their page to the main sidebar.
- Some advanced maps and lists still use native JSON or multiline editors, and some detailed
  diagnostics use expandable data views. They are not replicas of every original specialized
  editor, chart, transcript renderer, drag gesture or keyboard shortcut.
- The original desktop window/tray shell, OS file pickers and font discovery are not reproduced.
  The Web service ignores font changes, so the plugin explains that capability instead of
  displaying a save control that does nothing. Host terminal actions appear only when supported.
- Runtime tests cover selected workflows, not every API operation on every subscription vendor.
  The exposed API surface and field metadata require maintenance when Magpie changes.

The audit found and fixed the original zoom bug: Magpie uses 100/110/125/150 percent and
`settings/text-size`, not a 0–30 font-size field saved through general settings. Saves also
preserve hidden settings and credentials, use string model IDs rather than projected model
metadata, keep the undisplayed properties of rules and MCP entries, and use the API's actual
query parameters for request export and quota refresh. Cross-host query keys include the
Paseo host ID.

## Install

Requires Paseo 0.11.1 or newer and a running Magpie Web service on the daemon host.

```bash
paseo plugin install /absolute/path/to/paseo-plugins/magpie
```

Or install from this repository:

```bash
paseo plugin add git:lalaze/paseo-plugins --path magpie
```

Open **Magpie** in the sidebar. After changing local plugin source:

```bash
paseo plugin reload magpie
```

If migrating from the old `plugin-examples/magpie` directory, update the installed plugin source
to this directory. The plugin ID remains `magpie`.

## Connection

| Environment variable    | Default                                                                    |
| ----------------------- | -------------------------------------------------------------------------- |
| `PASEO_MAGPIE_UPSTREAM` | `http://127.0.0.1:3430`                                                    |
| `MAGPIE_WEB_KEY`        | On macOS, read from `~/Library/LaunchAgents/com.yetone.magpie.serve.plist` |

The upstream must be an HTTP(S) origin with no path, credentials or query string. On other
platforms, set `MAGPIE_WEB_KEY` in the Paseo daemon's environment. Opening the plugin does not start Magpie. Gateway restart and Magpie update controls
are explicit user actions. Magpie's native desktop window alone does not guarantee its Web API is running.

The client sends typed RPCs to Paseo, and the plugin calls Magpie from the host. Remote devices
do not need direct access to port 3430 or an additional proxy port. The Web key and upstream
cookie remain on the host; provider keys are displayed only in their masked form. The former
`PASEO_MAGPIE_PORT`, `PASEO_MAGPIE_BIND` and `PASEO_MAGPIE_PUBLIC_URL` options are no longer used.

To share subscriptions across computers, enable **Settings → 局域网共享**, then create a named key
on **Gateway → 网关密钥**. **查看并复制密钥** explicitly retrieves that key in a temporary dialog;
page polling and mutation notices contain no gateway credentials. On the other computer, add the
**Remote magpie** provider with the shared gateway address (port 3425 by default) and key, then
select its models for the local agents. Across networks, use the host's Tailscale address.
The shared host controls account routing and must stay running. A remote Agent routed to this
shared gateway uses that host's selected accounts and quota rules. Switching two independent local
sign-in files is a different operation; Remote magpie centralizes routing without syncing those files. Key budgets and model/account
restrictions are editable under the native Gateway page.

When Magpie reports permission errors reading its own settings or provider files, those errors
are shown in the plugin. Reloading the plugin cannot repair Magpie's file access. Check the
Magpie service and its permissions; restarting that service can interrupt requests it is serving.

## Development

```bash
cd magpie
npm ci --legacy-peer-deps
npm run check
```

Tests exercise the released client's native components without WebFrame, navigation and actions,
session reading, host-only authentication, secret projection, preservation of advanced fields,
upstream operation mappings and long-running jobs. Socket tests use temporary loopback fixtures;
they do not modify the user's Magpie configuration.

```bash
npm run preview
```

The standalone preview uses sample data, binds to `0.0.0.0:8225` and is available on this host at
`http://100.96.195.115:8225`. It does not connect to the real Magpie service.

API contracts were checked against the [official Magpie source](https://github.com/yetone/magpie/tree/main/internal/gui).
