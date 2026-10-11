> Historical validation record. Active code delivery now uses local workspace files; see [local delivery validation](local-delivery-validation.md).

# Text and attachment round-trip validation

Date: 2026-10-10 America/New_York (evidence recorded 2026-10-11 01:15 UTC).
Plugin source: the live Paseo installation of this checkout's `dot-bridge/`.
Connection: the previously configured Secure MCP Tunnel and existing ChatGPT dot.
No credentials, callback addresses or signing secrets are included here.

## Observed end-to-end result

Task `8fc9e471-359c-4264-8e49-fe69e8af99fc`, round `ce87e613-4f4e-4f89-9698-533b41accf55`:

1. Created through the live Paseo plugin RPC as a text task with no repository, remote, branch or base SHA. Its event was delivered to the real dot.
2. The dot initially waited for confirmation because its earlier conversation instructed it to only inspect notifications. After an explicit test execution message, it claimed the round.
3. The dot reported `waiting_user`: its cached tool directory did not contain `submit_dot_text_result`.
4. Reloaded the local plugin with `paseo plugin reload paseo-dot-bridge`. It returned `enabled: true`, `status: running`. Used ChatGPT's **Settings → Plugins → Paseo Dot Bridge → Refresh tools** to refresh the existing connection's tool directory.
5. Uploaded a synthetic UTF-8 file, `bridge-roundtrip.txt`, using the live Paseo attachment RPC. Immediately read it back and matched the bytes. The file contains a randomly generated marker and no workspace contents.
6. Asked the same dot to read that attachment and upload `reply.txt`, containing the prefix `attachment-roundtrip:` directly followed by the marker and a newline. The marker itself was only supplied inside the uploaded file, not in the follow-up instruction.
7. The real dot called the attachment tools and submitted a text result. A separate local read through Paseo verified the exact reply contents and SHA-256.
8. The final round is `completed`, `kind: text`, `coversLatest: true`. User sequence is 4 and the result acknowledges sequence 5 (which includes the dot's attachment note). Git verification is `none`; repository, branch and result SHAs are null.

The written result begins “文本通道已连通” and explains when to use text, attachments and Git delivery. The 119-byte input and 73-byte reply remain attached to the test task in Paseo.

Machine-readable evidence: [text-attachments-evidence.json](text-attachments-evidence.json).

## Local checks and remaining limits

`npm run check` passes type checking, 134 tests and bundling. Tests include a full 1 MiB binary upload/read over authenticated MCP HTTP, strict base64 and filename validation, checksums, task/connection membership, upload replay, revision races, 16-file quota, claim and round boundaries, coverage, restart recovery and old Git-store migration.

This validates actual remote text and small-file transport. It does not validate Paseo web/desktop/iOS/Android panel rendering. Native clients currently support pasted/copied text attachments; binary picking/saving requires desktop/web. Files are limited to 1 MiB each and 16 per task. Chunked large-file transfer, attachment deletion/garbage collection, direct workspace access and native provider registration remain unimplemented.
