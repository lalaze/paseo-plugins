> Historical validation record. Active code delivery now uses local workspace files; see [local delivery validation](local-delivery-validation.md).

# Native Dot provider validation

Validated on 2026-10-10 (America/New_York), using Paseo 0.11.1 and the existing `paseo-dot-bridge` connection. Machine-readable evidence: [provider-evidence.json](provider-evidence.json).

## Implemented

The plugin registers provider `dot` using `PluginServerContext.registerProvider`. It shares the existing Bridge engine and durable store. No ACP sidecar, new credentials, extra tunnel, or Paseo core patch is required.

One native conversation maps to one text task. A prompt and its attachments are saved together; a completed turn's follow-up opens the next round in that same transaction. Questions yield the local turn so the user can answer within the current Bridge round. Failed/stopped rounds get a new attempt identity. Stable client-message identities prevent duplicate work, and mismatched replays fail.

Native provider persistence stores the task/workspace binding. Restore replays messages, results and files, and follows active remote work without dispatching it again. Session close detaches; explicit interrupt requests a stop. Until remote acknowledgment, subsequent work is blocked. State v6 adds nullable provider metadata; migration preserves the original v5 file.

## Observed live

- Provider catalog lists **Dot → Connected Dot**.
- Agent: `7de7bb8a-89b2-4c48-a3d1-f3a5d6351238` (`Dot provider 会话验收`).
- Bridge task: `7d77a46e-a61e-4dda-8ef9-369b95995a58`.
- Round 1 returned `DOT-PROVIDER-OK` and the exact synthetic random marker through the native chat timeline. Agent returned to idle.
- Round 2 automatically opened in the same task. Dot recovered the marker from prior history and returned `FOLLOWUP-OK` without being given the marker again.
- Reloaded the plugin and called Paseo's session refresh. The original task and conversation history remained available.
- Round 3 uploaded `provider-input.txt` using Paseo's real file-upload API and sent it as a native chat attachment. Dot read it, uploaded `provider-reply.txt`, and submitted `PROVIDER-ATTACHMENT-OK`.
- Reply bytes exactly matched `ACK:` followed by the complete input file. All four results covered the latest user input. The agent was idle and the Bridge task completed.
- Round 4 was sent by clicking Send in the actual web chat composer and returned `FINAL-UI-OK`. The updated status card was visible and opened to show remote progress.
- The connected Paseo web client displayed the normal conversation, model selector, both replies, input/output attachment cards and download buttons. The conversation was also inspected at a 390 × 844 web viewport; this is not a native-phone test. The viewport override was reset afterward.
- Visual inspection prompted a final presentation improvement: provider status now updates a single work card, and attachment cards replace the redundant internal-ID notification. A final session refresh displayed the clean replay and the completed status card.

## Automated validation

`npm run check`: typecheck, **143 tests**, build. The new provider suite covers native protocol event validation, replies and continuation, completed-message replay, question/answer, requested versus acknowledged cancellation, simultaneous prompt/interrupt, attachment transport and bounds, stored bindings, recovery of active work, workspace mismatch, missing committed task, invalid file atomicity, and changed-content replay rejection. Existing Git, MCP HTTP, store and attachment checks remain green.

The first unprivileged run could not bind its local HTTP test servers (`listen EPERM`). Re-running with the required sandbox permission passed; this was not a product test failure.

## In-progress conversation feedback

Running notes from `report_dot_progress` now become visible assistant messages, without ending the local turn. The active status card uses the latest note only when it covers the current user input; stop requests retain their explicit status. Completed turns keep their progress messages on replay. Attachment bookkeeping remains separate from chat progress.

Every authenticated `get_dot_task` response for a native text conversation includes current delivery guidance, so existing tasks benefit without a store migration. It asks Dot to acknowledge longer work, report useful milestones in the user's language, and submit the final answer separately. It does not request private reasoning or fabricated activity. The progress tool description and connection setup instructions carry the same guidance.

Two additional regression checks cover visible progress before completion, duplicate-report handling, replay, new-round status isolation, and native-only delivery instructions through the real MCP HTTP server. Typecheck, all 143 tests and build passed before the installed plugin was reloaded.

The first live comparison request still returned only a final answer. The existing subscription's reply instructions were then explicitly updated to acknowledge comparison/checking/multi-step requests through the progress tool before working; Dot confirmed the save without changing its permission scope. A fresh conversation (`2971ad0a-a9a7-4db0-ac24-cb36fa837f51`) using the same synthetic comparison request emitted a concrete acknowledgment while its task was still `running` and had no result. Both the native timeline and the connected web UI showed that message before the final answer. Completion preserved the acknowledgment and returned a result covering the latest input. This verifies one real pre-final update, not a guaranteed 30–60 second cadence. See [progress evidence](provider-progress-evidence.json).

This is incremental message delivery when Dot calls the progress tool, not access to Dot's internal execution stream. Cloud wake-up latency and time spent inside a long tool call can still delay the first or next update.

## Automatic task handling

The existing Dot event subscription originally had a **read-only connection-test scope**. It initially announced the first provider task but did not execute it. Explicit permission for this synthetic task and its follow-up rounds allowed all four rounds to complete.

The user subsequently explicitly approved automatic handling of **future** native-provider text conversations, attachments and follow-ups. Dot confirmed that the existing `paseo.dot.task_changed` subscription was actually updated and remains enabled. The rule processes user-submitted `mode=text` tasks whose `provider` binding is non-null; attachments are used only for the purpose in the user's message. New permissions, destructive/high-risk actions and external publication still require a question through `waiting_user`. Existing Git-task rules remain unchanged. The earlier automatic-review rejection is resolved by this explicit approval.

A new native conversation then verified the rule without any task-specific start confirmation. Agent `1ad72c04-9ae4-4d78-ba83-3415bc7091b7` (`Dot 自动接单验收`) created task `494fac1b-f7e0-4b84-b135-d58a4dd47fac` from an ordinary two-line reply request. Dot automatically claimed and completed it, returned `AUTO-START-OK` and the exact random marker, and the reply appeared in the native timeline. The task was `completed`, its result had `coversLatest: true`, and the agent returned to `idle`. See [automatic-handling evidence](provider-autostart-evidence.json).

## Remaining limits

Desktop native UI automation timed out. Web UI was verified through the existing host connection; no new host pairing was created. Native mobile UI remains unverified.

Clicking the reply download button did not produce a browser download event within the automation timeout. Inspecting Chrome's download-history page was blocked by browser security policy, and no workaround was attempted. Thus file retrieval and exact bytes are verified through the authenticated Bridge API, but browser save-to-disk is **not** claimed as verified.

No local workspace tools or injected MCP tools are forwarded to Dot. No Git delivery mode, model switching, token streaming, usage accounting or rewind is offered by this provider preview. Git delivery remains available in the task panel. Attachment limits remain 1 MiB per file and 16 per conversation; native binary file saving remains outside this preview.
