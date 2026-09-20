# Pi Qwen thinking levels

Pi companion extension for the local `qwen3.8-flash-next` model. Pi's
`qwen-chat-template` compatibility mode sends `enable_thinking` and
`preserve_thinking`, but omits the selected reasoning strength. This extension
adds `chat_template_kwargs.reasoning_effort` immediately before each request.

| Pi level | Qwen request |
| --- | --- |
| off | `enable_thinking: false` |
| minimal, low | `enable_thinking: true`, `reasoning_effort: "low"` |
| medium | `enable_thinking: true`, `reasoning_effort: "medium"` |
| high, xhigh | `enable_thinking: true`, `reasoning_effort: "xhigh"` |

Qwen supports low, medium and xhigh, so Pi's minimal/high are aliases. The
installer adds `thinkingLevelMap` to expose xhigh in Pi's model capabilities.
The hook applies only to this model ID, the OpenAI completions API and the
`qwen-chat-template` compatibility mode. It preserves other payload fields,
including images, tools and `preserve_thinking`.

This is a **Pi extension**, loaded from `~/.pi/agent/extensions/qwen-thinking/`.
It is not a Paseo provider plugin and does not patch installed npm package files.

## Install

Run on each host using the same OS user as Pi/Paseo:

```sh
node pi-qwen-thinking/install.mjs
```

Optionally select the default level for new Pi sessions:

```sh
node pi-qwen-thinking/install.mjs --default-thinking medium
```

The installer backs up configuration under `~/.pi/agent/backups/`, preserving
unrelated model/provider settings. Reload Pi or refresh the idle Pi agent in
Paseo after installation; existing sessions retain their selected thinking level.
Pi launched with extensions disabled will not apply this mapping.

## Verify real requests

```sh
node pi-qwen-thinking/verify.mjs \
  --pi-cli /absolute/path/to/pi/dist/cli.js \
  --provider local-vllm \
  --extension-dir "$HOME/.pi/agent/extensions/qwen-thinking" \
  --report /tmp/qwen-thinking-check.json
```

Use the actual CLI path and provider name on each host. Newer Pi releases may
use `dist/bundle/cli.js`. The check runs the real Pi CLI at all six levels with
an isolated agent directory and a loopback mock server. It copies only the
model's public configuration, uses a dummy key, and saves only the thinking
parameters. It never calls the production model. `--baseline` without an
extension verifies the original missing-effort behavior.

To roll back, remove the installed `qwen-thinking` extension directory and
restore the modified model mapping (and optional default thinking setting)
from the backup, preserving any later edits to the configuration. Refresh Pi.
