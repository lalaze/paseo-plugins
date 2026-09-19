import type { Conversation } from "../shared/conversation";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { SettingsSchema, type Run, type Settings } from "../shared/schema";
import { DraftStateSchema, documentKey, type DraftState } from "../shared/settings-draft";

/** One writer per database. Each saved run is an atomic checkpoint. */
export class Store {
  private db: DatabaseSync;
  private owner = randomUUID();
  constructor(path: string, lock = true) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, run_id TEXT NOT NULL, actor TEXT NOT NULL, UNIQUE(run_id, actor));");
    this.db.exec("CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL)");
    if (lock) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const owner = this.meta<{ pid: number }>("owner");
        // A row left by this same process is a previous plugin generation whose
        // cleanup did not finish, not a concurrent instance.
        if (owner && owner.pid !== process.pid) {
          let alive = true;
          try { process.kill(owner.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
          if (alive) throw new Error("另一个 AI 协作实例正在使用此数据库");
        }
        this.setMeta("owner", { pid: process.pid, token: this.owner }); this.db.exec("COMMIT");
      } catch (e) { this.db.exec("ROLLBACK"); this.db.close(); throw e; }
    }
  }
  meta<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  setMeta(key: string, value: unknown) { this.db.prepare("INSERT OR REPLACE INTO meta VALUES (?,?)").run(key, JSON.stringify(value)); }
  settings(): Settings | undefined { const s = this.meta("settings"); return s ? SettingsSchema.parse(s) : undefined; }
  saveSettings(s: Settings) { this.setMeta("settings", SettingsSchema.parse(s)); }
  settingsDraft(): DraftState { return DraftStateSchema.parse(this.meta("settings-draft") ?? { revision: 0, draft: null }); }
  writeSettingsDraft(input: DraftState): DraftState {
    const parsed = DraftStateSchema.parse(input);
    if (this.settingsDraft().revision !== parsed.revision) throw new Error("另一窗口已更新设置草稿。请先重新读取草稿，再继续编辑。");
    const next = { ...parsed, revision: parsed.revision + 1 }; this.setMeta("settings-draft", next); return next;
  }
  commitSettings(settings: Settings, base: Settings | null, draftRevision: number) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (documentKey(this.settings() ?? null) !== documentKey(base)) throw new Error("已生效的设置在另一窗口有更新。请先重新读取设置，再应用你的修改。");
      const draft = this.writeSettingsDraft({ revision: draftRevision, draft: null });
      this.saveSettings(settings); this.db.exec("COMMIT");
      return draft;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  conversations(): Conversation[] { return this.db.prepare("SELECT data FROM conversations ORDER BY rowid DESC").all().map(row => JSON.parse(String(row.data))); }
  conversation(id: string): Conversation {
    const row = this.db.prepare("SELECT data FROM conversations WHERE id=?").get(id);
    if (!row) throw new Error("协作会话不存在");
    return JSON.parse(String(row.data));
  }
  saveConversation(value: Conversation) {
    this.db.prepare("INSERT INTO conversations VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(value.id, value.requestId, JSON.stringify(value));
  }
  findRequest(id: string): Run | undefined { return this.decode(this.db.prepare("SELECT data FROM runs WHERE request_id=?").get(id)); }
  get(id: string): Run { const r = this.decode(this.db.prepare("SELECT data FROM runs WHERE id=?").get(id)); if (!r) throw new Error("任务不存在"); return r; }
  all(): Run[] { return this.db.prepare("SELECT data FROM runs ORDER BY rowid DESC").all().map(r => this.decode(r)!); }
  unfinishedWorkspaceRuns(): Pick<Run, "id" | "workspaceId" | "cwd">[] {
    return this.db.prepare("SELECT id, json_extract(data,'$.workspaceId') AS workspaceId, json_extract(data,'$.cwd') AS cwd FROM runs WHERE json_extract(data,'$.phase') <> 'completed' AND json_extract(data,'$.control') <> 'canceled'").all() as Pick<Run, "id" | "workspaceId" | "cwd">[];
  }
  pending(): Run[] {
    return this.db.prepare("SELECT data FROM runs WHERE json_extract(data,'$.phase') <> 'completed' AND json_extract(data,'$.control') IN ('running','waiting_permission','canceling')").all().map(r => this.decode(r)!);
  }
  insert(run: Run) { this.db.prepare("INSERT INTO runs VALUES (?,?,?,?)").run(run.id, run.requestId, run.revision, JSON.stringify(run)); }
  save(run: Run) {
    const old = run.revision; run.revision++; run.updatedAt = Date.now();
    const result = this.db.prepare("UPDATE runs SET revision=?,data=? WHERE id=? AND revision=?").run(run.revision, JSON.stringify(run), run.id, old);
    if (result.changes !== 1) { run.revision = old; throw new Error("任务状态已变化，请刷新后重试"); }
  }
  token(runId: string, actor: string): string {
    const existing = this.db.prepare("SELECT token FROM tokens WHERE run_id=? AND actor=?").get(runId, actor) as { token: string } | undefined;
    if (existing) return existing.token;
    const token = randomUUID() + randomUUID(); this.db.prepare("INSERT INTO tokens VALUES (?,?,?)").run(token, runId, actor); return token;
  }
  authenticate(token: string): { run_id: string; actor: string } | undefined {
    return this.db.prepare("SELECT run_id,actor FROM tokens WHERE token=?").get(token) as { run_id: string; actor: string } | undefined;
  }
  private decode(row: unknown): Run | undefined { return row ? JSON.parse((row as { data: string }).data) as Run : undefined; }
  close() {
    if (this.meta<{ token: string }>("owner")?.token === this.owner) this.db.prepare("DELETE FROM meta WHERE key='owner'").run();
    this.db.close();
  }
}
