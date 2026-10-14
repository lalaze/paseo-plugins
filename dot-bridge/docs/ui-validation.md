# Dot tasks UI validation

Validated on 2026-10-14 (round 2, after review). Covers the Dot tasks panel rework plus the review
fixes: preserved draft/pending operation across collapse, visible workspace names on history cards,
≥44px compact touch targets, and a readable authorization panel.

## What changed

- `client/panel.tsx` — high-coverage content panels over the host wallpaper, segmented navigation,
  single-row searchable workspace picker, task search + status buckets, two-line cards with a true
  status marker, and an on-demand `TaskEditor`.
  - The editor is **kept mounted and hidden** when collapsed, so a draft and a pending operationId
    survive collapse/expand. It is still keyed by `workspaceId`, so switching workspace remounts it
    and isolates the draft; a late create response is ignored if the user has switched away.
  - History cards resolve `task.workspaceId` through the loaded `workspaces.list` names (raw id as a
    safe fallback in the all-workspaces scope) and render the origin in a truncatable box next to a
    non-shrinking timestamp, so a long remote device UUID never hides the time.
- `client/panel-model.ts` — framework-free view logic: status buckets, search matching, counts,
  time-ago formatting and workspace filtering.
- `client/kit.tsx` — additive `panelFill` / `cardFill` / `controlFill` helpers, an optional `height`
  override on `Button` (backward compatible; default sizes unchanged) and web-readable `aria-*` state.
- `client/editor.tsx` — panel surface, accessibility labels, `compact` fields (≥44px) and a ≥44px
  submit button.
- `client/workspace-authorization.tsx` — now renders on a `panelFill` surface (border kept, no double
  border) and accepts `compact` for ≥44px controls.
- `tests/panel-model.test.ts` — 8 behavior tests for the derived view logic.

No server, persistence, permission or native-sidebar file was touched. No dependency was added.

## Data source and harness (important limits)

The screenshots are **real `DotBridgePanel` component renders**, not an HTML mock-up. A temporary,
read-only harness:

- imports the actual `client/panel.tsx` (and its real `query.ts`, i18n, editor and detail children);
- aliases the host-only module `@getpaseo/plugin/client/react-native` to a shim
  (`ScrollView`/`TextInput` re-exported from `react-native-web`, no-op `useToast`/`copyText`, a text
  `Icon`), because the real host provides that module at runtime and it is not published;
- aliases `react-native` to `react-native-web` and renders with the same React 19 / React Native Web
  versions the Paseo desktop app uses;
- supplies **mock data**: 9 fake workspaces and 12 fake tasks (varied `remoteStatus`, Git/text mode,
  remote device, including three tasks that share one title across three workspaces and one with a
  long remote device UUID), returned by a mock `rpc` that honors the real `taskList` / `taskCreate` /
  `workspace-authorization-get` / `connection-status` contracts through the real `createBridgeQuery`.

Mock limits: no real daemon, store, workspace list, Git verification or permissions are exercised;
the wallpaper is a generated SVG, not the user's real image; `Icon`, toasts and clipboard are shimmed.
`taskCreate` is mocked to fail as an uncertain transport error so the retry/operationId behavior can
be observed. The real host's Electron/RN renderer was not launched. Because the preview is served over
HTTP on a LAN IP (not a secure context, unlike the Paseo host), the harness page polyfills
`crypto.randomUUID` only so `usePendingOperation` can mint ids.

The harness lived at `/tmp/dot-ui-harness` (outside the repo, not committed), served on
`http://100.96.195.115:8899` bound to `0.0.0.0`, and was removed after validation.

## Commands and results

Run in `dot-bridge/` (dependencies reused from the local checkout via a temporary `node_modules`
symlink that was removed afterwards):

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass (no output) |
| `npm test` | pass: 298 tests, 33 suites, 0 fail (194 top-level tests; includes the 8 `panel-model` tests) |
| `npm run build` | pass: esbuild client/server bundles written |
| `npm run check` | pass (typecheck + test + build) |

Focused run: `node --import tsx --test tests/panel-model.test.ts` → 8 pass.

## Browser checks (real component)

Viewport 1682×961 (desktop) and 390×844 (compact) via `agent-browser` against the preview.

### P1 — draft and pending operation survive collapse

1. Selected workspace `main`, expanded the editor, typed title `repeat create` / requirement
   `same requirement`.
2. First create hit a mocked uncertain transport failure. Captured operationId `9f9283ca-…-d16b`.
3. Collapsed the editor (hidden, `offsetParent === null`), re-expanded: title and requirement were
   still present.
4. Created again with the same content: captured operationId was byte-identical
   (`9f9283ca-…-d16b`), so the frozen operation is reused instead of minting a second one.
5. Opened the workspace picker and switched to a second workspace: the editor remounted with empty
   fields and the old draft was not submitted (create call count stayed at 2).

### P2 — workspace name, compact touch targets, authorization surface

- **Workspace names:** in the all-workspaces scope, three tasks titled `重复标题任务` from `main`,
  `当前项目接下来的功能` and `paseo` render distinct cards and distinct accessible labels
  (`重复标题任务 · main · 排队中 · 7 分钟前`, …). The card with the long device UUID keeps its
  timestamp visible; measured `timeVisible: true` for every card on desktop and at 390px.
- **Compact targets (390×844, all measured ≥44px, no horizontal overflow):** nav tab 44, status
  radios 44, create button 44, title input 44, requirement textarea 72, authorization toggle 44,
  authorization confirm 44 / cancel 44, task-list retry 44, workspace retry 44, clear-filters 44.
  `documentElement.scrollWidth === clientWidth === 390`.
- **Authorization surface:** the panel root now computes to `rgba(11, 12, 14, 0.96)` (the `panelFill`
  token) in both the list branch and the task-detail branch, so the wallpaper no longer shows through
  its title or explanation. Enable/confirm logic and RPCs are unchanged.

Other checks carried over: workspace search/select, task search + `已完成` (`4 / 9`), no-match +
`清除筛选`, opening a task from a filtered list and returning with the filter intact, loading
(`读取任务中…`), task-RPC error + `重试`, workspace-RPC error + `重试`, and accessibility
(`role="tab"`+`aria-selected`, `role="radio"`+`aria-checked`, `aria-expanded`, `tabIndex=0`).

## Screenshots

All are renders of the real component with mock data (see limits above).

- `dot-tasks-desktop-zh.png` — desktop 1682×961, all workspaces.
- `dot-tasks-workspaces-zh.png` — workspace picker expanded.
- `dot-tasks-workspaces-distinct-zh.png` — same-title tasks distinguished by workspace name.
- `dot-tasks-auth-zh.png` — authorization panel on its own surface.
- `dot-tasks-filter-empty-zh.png` — no-match filter state with `清除筛选`.
- `dot-tasks-compact-zh.png` — 390×844 compact layout with wrapped chips and workspace names.
- `dot-tasks-desktop-en.png` — English strings at desktop width.

## Remaining limits

- Not verified inside the real Paseo host/Electron app, on iOS/Android, or against real daemon data;
  the host `react-native` module was shimmed for rendering.
- The generated wallpaper only approximates a busy real photo; contrast is checked visually, not
  measured.
- The 4-second task refetch interval and real loading timing were not stress-tested; the operationId
  retry check used a single mocked failure, not a real lost response.
