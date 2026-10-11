> Historical validation record. Active code delivery now uses local workspace files; see [local delivery validation](local-delivery-validation.md).

# Real-dot validation

Date: 2026-10-10. Surface: the user's existing dot in ChatGPT Work on Chrome.
The account plan was not recorded. Paseo host version: 0.11.1. Bridge version:
0.1.0. MCP protocol: `2026-07-28`. Connection method: Secure MCP Tunnel with
a restricted runtime key and a local MCP bearer-header secret reference.
Keys, callback URLs, signing secrets and connection challenges are omitted.

## Observed results

- The tunnel runtime reports `process_running: true`, `healthy: true` and
  `ready: true`.
- ChatGPT installed and connected the custom Paseo Dot Bridge plugin and
  discovered both event definitions.
- A real `list_dot_tasks` call initially failed with JSON-RPC `-32000` and
  `Unrecognized key: "_meta"`. The HTTP request-parameter parser rejected
  standard MCP metadata before invoking the tool.
- The fix validates and removes protocol-level `params._meta` before method
  dispatch. Business arguments remain strict. Both the original HTTP replay
  and the real dot's retry now return `tasks: []`.
- The same dot created real subscriptions to `paseo.dot.task_changed` and
  `paseo.dot.connection_test`. The bridge stored two subscriptions and two
  successful callback verifications.
- A connection-test event was delivered to the real callback. Without another
  chat prompt, it woke the same dot, which called `confirm_dot_connection` with
  the event's challenge. The bridge reports all connection facts true,
  including `dotVerified` and `ready`.
- Two task events were delivered, and the same dot read both tasks. Both
  rounds were dispatched. The current workspace lists both tasks; a separate
  existing workspace lists none.
- The dot claimed both rounds separately and called `report_dot_progress`
  for each with its own task/round identifiers and `processedThroughSeq: 1`.
  The initial reports were `waiting_user`: the account's coding environment
  directory was empty, and its listed computer was offline and unauthorized.
  The existing dot cloud computer with independent sequential checkouts was
  authorized as the next delivery path.
- The dot prepared one local commit per independent checkout and reported
  successful Python checks of both working-tree and committed JSON, exact
  four-field values, a parent equal to the fixed base, ancestry, a single-file
  diff, `git diff --check`, and clean working trees. GitHub CLI has no signed-in
  host or configured credential helper. Both rounds initially reported
  `waiting_user` for remote delivery, without submitting a local-only result.
- The installed GitHub plugin is enabled, but the real dot reports that no
  GitHub read/write tools are exposed to its current session. That existing
  connection therefore did not provide a delivery path.
- The Codex Cloud creation UI also requires a separate **Connect GitHub**
  authorization before it can list repositories. The user approved preparing
  a connection for account `lalaze`, limited to `lalaze/paseo-plugins`, with
  final authorization reserved for the user's confirmation. After the user
  logged in, the UI showed the correct account and repository. The GitHub
  installation settings revealed that ChatGPT Codex Connector was already
  installed and had access to all repositories. After the user's explicit
  final confirmation, the agent saved `Only select repositories` with
  `lalaze/paseo-plugins` as the sole selection. Reloading the GitHub settings
  page confirmed that the restricted selection persisted.
- The GitHub permissions page lists read access to checks, commit statuses
  and metadata, and read/write access to actions, code, issues, pull requests
  and workflows. GitHub also includes read-only access to public repositories
  with the selected-repositories setting. A Codex Cloud environment named
  `paseo-plugins` was created with only that repository and `Only me` access.
  Its onboarding task prepared the machine and reusable install/start
  instructions. The reviewed draft was saved and the UI confirmed
  `Published`. Start instructions preserve unrelated changes and explicitly
  follow the assigned task's base and branch. Both existing bridge tasks
  received an answer message authorizing continuation through this
  environment with their original task/round identifiers and frozen bases.
- Those follow-up events woke the same dot, which read the latest messages
  and reported both rounds as `running`, acknowledging user-message seq 6.
  It started distinct cloud tasks named `验证并交付 Bridge A` and
  `验证并交付 Bridge B`; both cards simultaneously showed `Working` at
  13:35 America/New_York. The A task subsequently reported 2m 14s of work
  and a successful normal push and remote fetch.
- Both cloud tasks produced new commits in their isolated environments;
  the earlier pre-authorization local commits were not used as remote heads.
  The same dot called `submit_dot_result` for both existing rounds, then
  re-read their accepted results. Both are `completed`, `verified` and
  `coversLatest: true`, with `processedThroughSeq: 7` covering user seq 6.
- Independent `ls-remote` and fresh bare-repository fetches verified both
  reported heads, each commit's sole parent equal to the frozen base,
  ancestry, the exact four JSON fields and values, one added fixture only,
  and `git diff --check`. The fetched heads equal the bridge's verified
  heads. See [Git verification evidence](phase-0-git-results.json).

MCP reserves `_meta` for protocol metadata; it is separate from tool business
arguments. See the [MCP base protocol](https://modelcontextprotocol.io/specification/2025-11-25/basic#_meta).
The subscription and signed callback checks use the
[OpenAI MCP Events contract](https://developers.openai.com/plugins/build/mcp-events).

## Git delivery trials

Repository: `lalaze/paseo-plugins`. Remote: `origin`. Fixed base:
`2b627271fe4c57e57ea0d5062737ee950df3a2eb`. Target branch: `main`.
Each trial requests one JSON fixture on its own task branch, with an actual
Python check and a pushed commit. No merge or PR is requested.

| Trial | Task ID | Round ID | Branch | Verified remote head | Delivery |
| --- | --- | --- | --- | --- | --- |
| A | `b6c40a47-a866-45e3-8d0e-933981cfbe38` | `51f44385-8405-44b1-b4b7-fe1145c48087` | `dot/b6c40a47-a866-45e3-8d0e-933981cfbe38` | `202c38735cb1a7403ce6ed3c5dd6d3af5136b836` | Pushed; completed, verified, coversLatest |
| B | `cd57e852-9179-45b8-a753-9d305cd2f0af` | `bd400f82-bf35-4c50-b223-a196b5576a1c` | `dot/cd57e852-9179-45b8-a753-9d305cd2f0af` | `6d895a5a7b3a5b475890b142d0aaaa7e6be1ec34` | Pushed; completed, verified, coversLatest |

The two independent cloud-task cards were observed running simultaneously,
and both remote deliveries passed. This is trial evidence, not a guarantee
of future concurrency or quota. Paseo web, desktop, iOS and Android panel
rendering are not validated by this Chrome/MCP integration check.

## Local regression checks

`npm run check`: typecheck, 124 tests (124 passed, 0 failed), and build passed.
The added HTTP regression cases cover request metadata on tool calls and
event subscription methods, malformed metadata, and strict business inputs.

Cloud-environment onboarding also checked the committed Usage Glance and
Translate packages. Translate passed 48 tests; Usage Glance initially passed
110, but a repeat exposed two intermittent filesystem/event-loop timing
failures in `test/consumption-sync.test.ts`. This is a separate existing-package
limitation, recorded in the cloud start instructions. Both package typechecks,
compilation and Hermes probes passed. No repository source was changed by
onboarding, and these checks do not substitute for Dot Bridge's 124 tests or
its outstanding live Paseo panel checks.
