import { mkdir, writeFile, rename, chmod, readdir, readFile, unlink, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function conversationQueueRoot(root: string) {
  return join(tmpdir(), `paseo-director-${process.getuid?.() ?? "user"}`, digest(resolve(root)));
}
const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

// Filesystem IPC works inside the existing agent's sandbox: it needs neither
// network access nor a provider restart. Only the owning OS user can read it.
export class ConversationBridgeServer {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private stopped = false;
  constructor(private root: string, private call: (token: string, name: string, args: unknown) => Promise<unknown>) {}
  async start() {
    const directory = conversationQueueRoot(this.root);
    await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
    this.timer = setInterval(() => {
      if (this.stopped || this.pending) return;
      this.pending = this.pump().catch(error => console.error("Director bridge:", error instanceof Error ? error.message : String(error))).finally(() => { this.pending = undefined; });
    }, 100);
  }
  private async pump() {
    const directory = conversationQueueRoot(this.root);
    for (const name of await readdir(directory)) {
      if (this.stopped) break;
      if (!/^[\da-f-]{36}\.request\.json$/.test(name)) continue;
      const path = join(directory, name);
      const info = await lstat(path).catch(() => undefined);
      if (!info?.isFile()) continue;
      const response = path.replace(/\.request\.json$/, ".response.json");
      // A crash after writing the receipt must not execute the request again.
      if (await lstat(response).catch(() => undefined)) { await unlink(path).catch(() => {}); continue; }
      let reply: { value?: unknown; error?: string };
      try {
        if (info.size > 262144) throw new Error("协作请求过大");
        const request = JSON.parse(await readFile(path, "utf8"));
        if (typeof request.token !== "string" || typeof request.name !== "string") throw new Error("协作请求无效");
        reply = { value: await this.call(request.token, request.name, request.arguments) };
      } catch (error) { reply = { error: error instanceof Error ? error.message : "协作请求失败" }; }
      await writeFile(`${response}.tmp`, JSON.stringify(reply), { mode: 0o600 });
      await rename(`${response}.tmp`, response);
      await unlink(path).catch(() => {});
    }
  }
  async close() { this.stopped = true; if (this.timer) clearInterval(this.timer); await this.pending; }
}

export async function writeConversationBridge(root: string, id: string, token: string) {
  const directory = join(root, "bridges"), queue = conversationQueueRoot(root);
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  await mkdir(queue, { recursive: true, mode: 0o700 }); await chmod(queue, 0o700);
  const path = join(directory, `${digest(id)}.mjs`);
  const source = `import { readFileSync } from 'node:fs';
import { writeFile, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const names = ['get_conversation_status', 'start_task', 'submit_operation', 'control_task'];
try {
  const name = process.argv[2];
  if (!names.includes(name)) throw new Error('工具名称无效：' + names.join(', '));
  const args = name === 'get_conversation_status' ? {} : JSON.parse(readFileSync(0, 'utf8'));
  const base = join(${JSON.stringify(queue)}, randomUUID());
  const request = base + '.request.json', response = base + '.response.json';
  const body = JSON.stringify({ token: ${JSON.stringify(token)}, name, arguments: args });
  if (Buffer.byteLength(body) > 262144) throw new Error('协作请求过大');
  await writeFile(request + '.tmp', body, { mode: 0o600 });
  await rename(request + '.tmp', request);
  const deadline = Date.now() + 120000;
  let reply;
  while (Date.now() < deadline) {
    try { reply = JSON.parse(await readFile(response, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await sleep(100);
  }
  if (!reply) throw new Error('协作工具等待超时，请检查插件状态。请求可能已执行；先查询状态，不要盲目重复提交。');
  // Remove the request first so an acknowledged response cannot be replayed.
  await unlink(request).catch(() => {}); await unlink(response).catch(() => {});
  if (reply.error) throw new Error(reply.error);
  console.log(JSON.stringify(reply.value));
} catch (error) { console.error(error.message); process.exitCode = 1; }
`;
  await writeFile(`${path}.tmp`, source, { mode: 0o600 }); await chmod(`${path}.tmp`, 0o600);
  await rename(`${path}.tmp`, path);
  return path;
}

export function bridgeInstructions(path: string) {
  const command = `node ${shellQuote(path)}`;
  return `当前对话已启用 AI 协作，沿用本会话的模型、权限和历史。协作工具通过现有终端/命令执行工具调用，无需联网。\n命令：${command} get_conversation_status\n其余工具使用 ${command} <工具名>，通过标准输入传递 JSON（用带引号的 heredoc，避免 shell 展开）。工具名及参数：\nstart_task: {sourceMessageId, goal}\nsubmit_operation: {operationId, payload}（payload 按当前 operation.prompt 的 schema）\ncontrol_task: {sourceMessageId, action, confirmationKey?, goal?, feedback?}\naction 只能为：pause（暂停）、resume（继续）、cancel（取消）、retry（重试）、revise（修改需求）、approve_plan（批准方案）、accept_final（验收通过）、reject_final（不采纳成果）、request_changes（对成果提出修改）。批准和验收需传当前 confirmation.key 作为 confirmationKey。\n工具调用失败时报告实际错误；不得读取或输出桥接脚本内容与凭据。后续所说的同名协作工具均指上述命令，无需重新配置 MCP。`;
}
