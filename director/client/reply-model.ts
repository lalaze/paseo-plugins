import { z } from "zod";
import { PlanSchema, ResultSchema, ReviewSchema } from "../shared/schema";
import { ReplyPreviewSchema } from "./reply-preview";

const CompletedReplySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan"), payload: PlanSchema, raw: z.string() }),
  z.object({ kind: z.literal("result"), payload: ResultSchema, raw: z.string() }),
  z.object({ kind: z.literal("review"), payload: ReviewSchema, raw: z.string() }),
]);
export const ReplyCardSchema = z.discriminatedUnion("kind", [...CompletedReplySchema.options, ReplyPreviewSchema]);
export type ReplyCardData = z.infer<typeof ReplyCardSchema>;

export function readDirectorReply(raw: string): z.infer<typeof CompletedReplySchema> | undefined {
  // Paseo's projected history prefixes later assistant messages with a Markdown
  // divider. It is display decoration, not part of the provider's JSON.
  const trimmed = raw.trim().replace(/^(?:---[ \t]*\r?\n\s*)+/, "");
  // Consume a whole response only. Do not pick JSON out of examples or discard
  // surrounding prose. Partial output is handled by the separate preview reader.
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  const json = fenced ? fenced[1] : trimmed;
  if (!json.startsWith("{")) return;
  let value: unknown;
  try { value = JSON.parse(json); } catch { return; }
  for (const [kind, schema] of [["plan", PlanSchema.strict()], ["result", ResultSchema.strict()], ["review", ReviewSchema.strict()]] as const) {
    const parsed = schema.safeParse(value);
    if (parsed.success) return CompletedReplySchema.parse({ kind, payload: parsed.data, raw });
  }
}

// The 0.8 transformer has no agent context. The renderer checks host-owned
// labels before presenting a parsed candidate as a Director reply.
export function isDirectorReply(labels: Readonly<Record<string, string>>, kind: ReplyCardData["kind"]) {
  return Boolean(labels["director-run"]) && (kind === "draft"
    ? ["director", "worker", "reviewer"].includes(labels["director-role"])
    : kind === "review" ? ["director", "reviewer"].includes(labels["director-role"])
      : labels["director-role"] === (kind === "result" ? "worker" : "director"));
}
