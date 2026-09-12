import { z } from "zod";

export const ReplyPreviewSchema = z.object({
  kind: z.literal("draft"), stage: z.enum(["plan", "result", "review"]).optional(),
  summary: z.string(), architecture: z.string(), raw: z.string(),
});

const fields = ["summary", "architecture", "acceptance", "tasks", "status", "tests", "issues", "decision", "artifactId", "criteria", "findings"];

// Read only the received portion of a JSON string. Hold an unfinished escape
// (including Unicode) until its remaining characters arrive; never repair JSON
// or use preview text as a scheduler result.
function readString(text: string, start: number) {
  let end = start + 1;
  while (end < text.length) {
    const ch = text[end];
    if (ch === '"') return { value: JSON.parse(text.slice(start, end + 1)) as string, end: end + 1, closed: true };
    if (ch < " ") break;
    if (ch === "\\") {
      const escape = text[end + 1];
      if (escape === "u") {
        if (!/^[\da-f]{4}$/i.test(text.slice(end + 2, end + 6))) break;
        end += 6; continue;
      }
      if (!escape || !'"\\/bfnrt'.includes(escape)) break;
      end += 2; continue;
    }
    end++;
  }
  const value = JSON.parse(`${text.slice(start, end)}"`) as string;
  return { value: value.replace(/[\uD800-\uDBFF]$/, ""), end, closed: false };
}

function skipValue(text: string, start: number) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const string = readString(text, i);
      if (!string.closed) return text.length;
      i = string.end - 1;
    } else if (!depth && (ch === "," || ch === "}")) return i;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
  }
  return text.length;
}

export function readDirectorReplyPreview(raw: string): z.infer<typeof ReplyPreviewSchema> | undefined {
  const text = raw.trim().replace(/^(?:---[ \t]*\r?\n\s*)+/, "").replace(/^```(?:json)?[ \t]*\r?\n/i, "");
  if (!text.startsWith("{")) return;
  const preview: z.infer<typeof ReplyPreviewSchema> = { kind: "draft", summary: "", architecture: "", raw };
  let position = 1, recognized = false;
  const whitespace = () => { while (/\s/.test(text[position] ?? "") && position < text.length) position++; };
  while (position < text.length) {
    whitespace();
    if (position === text.length || text[position] === "}") break;
    if (text[position] !== '"') return recognized ? preview : undefined;
    const key = readString(text, position);
    if (!key.closed) return recognized || fields.some(field => field.startsWith(key.value)) ? preview : undefined;
    if (!fields.includes(key.value)) return recognized ? preview : undefined;
    recognized = true;
    if (["architecture", "acceptance", "tasks"].includes(key.value)) preview.stage = "plan";
    if (["status", "tests", "issues"].includes(key.value)) preview.stage = "result";
    if (["decision", "artifactId", "criteria", "findings"].includes(key.value)) preview.stage = "review";
    position = key.end; whitespace();
    if (text[position++] !== ":") break;
    whitespace();
    if (text[position] === '"') {
      const value = readString(text, position);
      if (key.value === "summary" || key.value === "architecture") preview[key.value] = value.value;
      if (!value.closed) break;
      position = value.end;
    } else position = skipValue(text, position);
    whitespace();
    if (text[position++] !== ",") break;
  }
  return recognized || text.slice(1).trim() === "" ? preview : undefined;
}
