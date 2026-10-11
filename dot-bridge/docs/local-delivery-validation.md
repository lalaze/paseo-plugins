# Local workspace delivery

Implemented on 2026-10-10 (America/New_York). This replaces the active Git-delivery workflow; earlier Git validation records are historical.

## Current behavior

All new tasks are conversations bound to the workspace directory resolved by Paseo. Native Dot sessions and panel tasks use the same engine. MCP now exposes `list_dot_files`, `read_dot_file` and `apply_dot_changes`, plus the existing progress, final-answer and attachment tools. `submit_dot_result`, repository inspection and result re-verification are removed from the installed public interfaces. The installed engine has no Git adapter. Legacy Git records remain readable, but are excluded from remote task listing and dispatch and cannot be claimed, continued or modified through normal task input.

File changes apply to the working directory, including uncommitted text. Each path has an expected content hash; new files require absence. The Bridge checks the connection, claimed/current round, latest user-message sequence and stop flag before writing. It rejects protected paths, traversal, symlinks below the root, hardlinks, binary/oversized content and ambiguous path batches. The server, not Dot, assigns the workspace root.

Files are atomically replaced individually. The batch is not an OS transaction: preflight rejects known conflicts before writing; a later failure reports the exact applied subset as partial. The original contents and durable per-operation outcome are saved in the private `local-changes` journal. Replays do not repeat writes after subsequent user edits. An interrupted batch is not blindly resumed, and changes already applied are not silently rolled back. External editors are not locked by the Bridge.

No shell execution is exposed. Dot must not claim local tests ran merely because source changes were applied.

## Automated checks

`npm run check`: typecheck, **153 tests**, build, all passed.

New checks cover actual non-Git filesystem creation/update/deletion; preservation of unrelated edits, byte-order marks and file permissions; stale-content preflight; path boundaries; protected paths; symlinks and hardlinks; UTF-8 size limits; duplicate and changed-content replay; interrupted batches; connection/claim/round/stop/latest-message checks; store restart; a state-save failure after successful file writes; authenticated MCP file read/write; and removed Git-tool rejection. Existing historical-format and task lifecycle tests still pass.

State v7 preserves previous state bytes before migration and adds local workspace bindings and receipts. Settings v3 removes Git defaults. Native conversations from earlier versions receive their local binding on their next prompt.

## Live validation

The installed plugin was reloaded, the connected ChatGPT plugin's tools were refreshed, and its description was updated to local workspace changes. Dot confirmed all three local tools were visible and saved the subscription rules for native conversations and new panel requests. The existing connection remained ready. The web task editor showed the unified request form with no repository/branch fields, and legacy Git records remained labeled as historical.

A new native conversation (`ad2d5e46-0eb0-4006-b7f7-1f9b4d37e695`) created task `8a36f3ce-4235-4776-9e21-7824e30be3d7`. It asked Dot to fix one synthetic `.mjs` file from addition to multiplication while preserving a random marker that was present only in the local file. Dot reported progress, read the actual source, applied one update through `apply_dot_changes`, and read it back. The task panel showed the real applied-file receipt before completion.

The delivered source preserved the marker and matched the requested function. After inspecting its exact contents, the local validation script ran `multiply(6, 7) === 42` and `multiply(-2, 3) === -6`; both passed. Dot accurately reported that it had not run commands or tests itself. The task completed with `coversLatest: true`, the agent returned to idle, and the native timeline contained the actual local-application message. The task has no repository or branch binding. Local repository HEAD stayed `2b627271fe4c57e57ea0d5062737ee950df3a2eb`.

A final plugin reload and native-session refresh preserved the completed task, its single file receipt and the source contents; no duplicate application occurred.

Machine-readable evidence: [local-delivery-evidence.json](local-delivery-evidence.json). The synthetic source is retained under `docs/fixtures/` with the path recorded in that evidence. Existing business files were not used for the live trial. Real remote conflict handling was not separately induced; stale hashes and partial-operation recovery were verified in automated filesystem/MCP tests.
