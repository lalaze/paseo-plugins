# Native Dot activity feed

Implemented and checked on 2026-10-11 (America/New_York), continuing the selected activity-feed work from Claude conversation `33083b9a-9043-40c4-a204-0dd31e382bd7`.

## Behavior

Authenticated MCP calls produce native provider tool cards when the call finishes. The normal provider poll interval is 750 ms. The feed shows message reads, directory listings, file reads, attachment reads and chunked upload progress. Reading the same user message again reuses its card. Chunk uploads reuse an operation card, count received chunks rather than the highest index, and finish alongside the existing attachment card. Unfinished uploads stop spinning when the round finishes, changes or receives a stop request. Refused file and upload operations expose the original failure; a mismatched connection produces no activity in another conversation.

Local-change receipts render one Edit card per applied file, including creation and deletion. Diffs compare the requested replacement with the original journal snapshot, rather than the current workspace file. Conflict batches have a failed card; partial batches show only their applied subset plus a failed conflict card. These replace the provider's plain application note; the task panel and durable task messages keep their existing receipts and notes. Replay orders messages, activities, attachments and edits by their timestamps. Card identities prevent repeated polls and exact operation retries from duplicating display. Receipts never change, so each session reads an operation's journal and builds its diff once; later polls skip it.

Activity observation does not change tool results, authorization, task messages or file-write behavior. The public MCP schema and subscription instructions are unchanged. Reloading the updated plugin enables the display; no ChatGPT tool refresh is required for this feature.

## Automated validation

`npm run check` passed: TypeScript checking, **170 tests**, and client/server esbuild bundles. `git diff --check` also passed. Building with the compiler from the deployed Paseo release (`PASEO_COMPILER`) verified client, server and import boundaries. HTTP integration tests ran outside the filesystem sandbox because that sandbox denies binding test ports.

Seven added provider integration tests exercise real authenticated MCP HTTP calls and validate emitted events with the SDK's `ProviderEventSchema`. They cover live activity before a final answer; task-read and chunk retry deduplication; read errors and connection isolation; create/update/delete diffs; exact write replay after later user edits; durable edit replay after reopening the store and engine; stale-content conflicts; interrupted partial-batch recovery; upload progress, completion, stop and rejection; replay order; invalid/missing journal fallback; preserving successful/error MCP outcomes when observation itself fails; and one journal read per session across repeated polls.

Five diff tests cover context, created/deleted files, separate/merged hunks, CRLF normalization and bounded large-rewrite fallback. A seeded 500-case test applies each generated line diff and verifies the resulting normalized lines against the new text.

## Limits and live status

This is Bridge activity, not token streaming or a view of Dot's work outside Bridge calls. Read/list/upload activities are an in-memory log capped at the most recent 200 entries per task. Reconnection within that plugin process replays the retained entries; plugin-process restart does not recover them. Applied-file cards remain durable through receipts and journals.

Diffs are line previews with three context lines. Comparisons exceeding two million changed-middle cells or producing more than 64 KiB of diff text omit the diff. Newline-only and line-ending changes can also have no visible line hunk. Missing or malformed journals retain completed file cards without their diff.

No installed-plugin reload, real remote Dot request, or browser/native UI validation was performed for this change. The emitted native provider protocol was exercised locally; desktop/mobile rendering and remote timing remain unverified. Already displayed transient upload cards are not reconstructed after a plugin restart and may retain their last visible state until a new chunk updates them.
