/** Pi extension for our Qwen3.8-Flash-Next OpenAI-compatible model. */
export const thinkingLevelMap = Object.freeze({
  off: "none",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "xhigh",
  xhigh: "xhigh",
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function rewriteQwenThinking(payload, model, level) {
  if (model?.id !== "qwen3.8-flash-next"
    || model.api !== "openai-completions"
    || model.compat?.thinkingFormat !== "qwen-chat-template"
    || !isObject(payload)
    || !Object.hasOwn(thinkingLevelMap, level)) return undefined;

  const kwargs = {
    ...(isObject(payload.chat_template_kwargs) ? payload.chat_template_kwargs : {}),
    enable_thinking: level !== "off",
  };
  if (level === "off") delete kwargs.reasoning_effort;
  else kwargs.reasoning_effort = thinkingLevelMap[level];

  const next = { ...payload, chat_template_kwargs: kwargs };
  // llama.cpp consumes the template argument. Avoid a conflicting root value
  // from an earlier hook overriding the selected level.
  delete next.reasoning_effort;
  return next;
}

export default function qwenThinking(pi) {
  pi.on("before_provider_request", (event, ctx) =>
    rewriteQwenThinking(event.payload, ctx.model, pi.getThinkingLevel()));
}
