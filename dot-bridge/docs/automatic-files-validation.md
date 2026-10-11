# Automatic file delivery validation

Date: 2026-10-11. Installed plugin: this checkout, reloaded and running.

## Verified behavior

The real connected Dot reused the PNG it previously generated and a synthetic 2 MiB text file. Both were sent through the new `upload_dot_attachment_chunk` tool over the existing Secure MCP Tunnel. No ChatGPT Library export, attachment-preview click or browser download was used for this round.

- PNG: 1,000,089 bytes, three chunks; SHA-256 `0f0c18cabb9685822b7231a9616dfa09bb1e398444747b2efa925af1e8a6cc67`.
- Synthetic text: 2,097,152 bytes, six chunks; SHA-256 `c0090a84d014fc746e0e58dfaa03178fa0619291ba04c4a9f4eee47e99a73e0c`.
- Dot repeated the first chunk of each file using the same operation ID. Both transfers completed with a single published attachment per file.
- The server automatically saved named files in its private `files/<taskId>/<operationId>/` directories. Independent local reads verified the original byte count, SHA-256 and mode 0600 for both files.
- Independent reads through the actual `task-attachment-chunk-read` plugin RPC reassembled the exact same bytes, using the Base64 concatenation used by the preview/download client.
- After refreshing the native agent, its timeline contained both attachment records and their saved local paths. Task status was `completed`.

Machine-readable evidence: [automatic-files-evidence.json](automatic-files-evidence.json). No credentials or signed download URLs are recorded.

## Automated checks and limits

`npm run check`: typecheck, **158 tests**, and client/server bundles passed. New tests cover 2 MiB authenticated HTTP delivery and reading, 20 MiB boundary assembly, out-of-order/repeated chunks, resuming after restart, whole-file corruption, changed manifests, stop/connection/round checks, destination isolation and edited-file protection. Incomplete uploads are bounded to sixteen per task.

The client adds PNG/JPEG/WebP/GIF previews and a copyable saved path. Automatic preview is limited to images up to 8 MiB; larger images have a preview button. SVG and HTML are not rendered. Actual visual verification of the updated client was **not completed** because desktop UI automation timed out. The client data RPC and native timeline were verified as above; this is not a claim of mobile or desktop visual QA.

Files are saved on the Paseo host, outside the project, without replacing project files. A remote phone does not receive a local filesystem copy. Large files still travel as bounded Base64 chunks over MCP; this does not create an unauthenticated HTTPS download URL. Existing platform tool approvals still apply. Completed files are retained; abandoned transfers expire after 24 hours and are cleaned when the same task next uploads.
