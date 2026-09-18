# Response Speed

Shows the generation speed of the current provider / model after every AI reply:

- Generation speed (t/s)
- Output token count
- Time to first token (TTFT)
- Overall average speed and total duration

Plugin ID: `paseo-response-speed`.

## Install

Enable plugins under **Settings → Plugins** in Paseo, then run:

```bash
paseo plugin add lalaze/paseo-plugins --path response-speed
```

Local development install:

```bash
paseo plugin install "$PWD/response-speed"
```

Run `paseo reload` after installing or updating. Every newly completed reply stores a speed card in the timeline; replies from before the install are not backfilled.

## Definitions

- **Generation**: provider-reported `outputTokens` ÷ time the model was actually working. Model time = total turn duration − tool execution waits − permission waits. It includes reasoning time and the time spent generating tool inputs.
- **Overall**: `outputTokens` ÷ time from turn start to completion. This includes tool calls and approval waits.
- **TTFT**: from turn start to the first reasoning or assistant output event.
- A tool wait starts at the tool's last `running` event whose input changed (Claude streams partial tool input while generating) and ends when it reaches completed / failed / canceled; parallel tools block until the last one finishes. A permission wait runs from `permission_requested` to `permission_resolved`; if the approved tool then executes, the wait extends until the tool ends.
- The plugin does not estimate generation time from gaps between output events: Paseo coalesces stream deltas in 60 ms windows and Claude delivers reasoning summaries as a single burst after thinking finishes, so event spacing is unrelated to real generation time.
- If no stream event at all was observed during the turn, only the overall speed is shown.
- `outputTokens` is reported by the provider and may include reasoning tokens; the exact meaning depends on the provider.
- If the provider does not report output tokens for the turn, t/s and the token count show `—`; the plugin never guesses from character counts.

These numbers are meant for comparing the real interactive speed of different models on the same Paseo host and similar tasks; they are not equivalent to vendor-published inference benchmarks.

## Verify

```bash
npm ci --include=dev --ignore-scripts
npm run check
```
