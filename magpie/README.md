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

## Pages

| Page      | Available actions                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents    | Scan agents, connect/disconnect, choose models and reasoning levels, reapply changed configurations, save/apply/delete profiles                                           |
| Sessions  | Search and page through history, read available transcripts, copy resume commands                                                                                         |
| Library   | Add MCP servers and install skills, distribute them to agents, remove entries; enable the library builtin when disabled                                                   |
| Providers | Add/edit API providers, choose exposed models, enable/disable sources, refresh catalogs, add/switch/delete API keys, switch accounts, start built-in subscription sign-in |
| Routing   | Create/edit ordered model groups, choose routing strategies, reorder members, enable/disable/delete groups                                                                |
| Gateway   | Inspect the endpoint, available model count and recent request metadata                                                                                                   |
| Usage     | Select a date range, inspect Token/cost charts and Agent/model breakdowns, optionally read subscription quotas                                                            |
| Plugins   | Discover community/GitHub plugins, search npm, install packages; enable/disable, upgrade and remove installed plugins; manage Magpie's builtins                            |
| Settings  | Save general Magpie preferences and proxy settings; inspect version, endpoint and data directory                                                                          |

These are real Magpie changes shared with its desktop app. Saves preserve advanced provider,
routing and settings fields that the native forms do not expose. Destructive controls ask for
confirmation. Installation jobs run on the host with progress polling.

This implements the management pages above, rather than every specialized editor in Magpie's
original app. For example, custom plugin login questionnaires, routing intent/rule editors,
library hooks/instructions and desktop-only window controls are not included. Session transcripts
are read-only and depend on the formats Magpie supports. Actual iOS/Android device testing is pending.

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
platforms, set `MAGPIE_WEB_KEY` in the Paseo daemon's environment. The plugin never starts or
restarts Magpie itself. Magpie's native desktop window alone does not guarantee its Web API is running.

The client sends typed RPCs to Paseo, and the plugin calls Magpie from the host. Remote devices
do not need direct access to port 3430 or an additional proxy port. The Web key and upstream
cookie remain on the host; provider keys are displayed only in their masked form. The former
`PASEO_MAGPIE_PORT`, `PASEO_MAGPIE_BIND` and `PASEO_MAGPIE_PUBLIC_URL` options are no longer used.

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
