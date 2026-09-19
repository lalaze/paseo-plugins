import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { SettingsSchema, PlanSchema, ResultSchema, ReviewSchema, hasFinalResult, canResumeRun, executionComplete, finalAcceptance, parseOutput, profileForTask, validatePlan, operationRole, operationLabel, REVIEWER_ACTOR, type Run, type Operation, type Settings, type Profile, type Review, type ControlAction, type FinalControl } from "../shared/schema";
import type { Repository } from "./repository";
import { Store } from "./store";
import { buildPrompt, responseSchema } from "./prompts";

export interface AgentSnapshot {
  status: "idle" | "running" | "permission" | "error" | "missing";
  seen: boolean; output: string; interrupted?: boolean; error?: string;
}
export interface AgentGateway {
  workspaceDirectory(workspaceId: string): Promise<string>;
  retainWorkspaceName(workspaceId: string): Promise<void>;
  create(run: Run, op: Operation, profile: Profile, token: string): Promise<string>;
  find(runId: string, operationId: string): Promise<string[]>;
  /** `since` (epoch ms) bounds how far back history is searched for the marker. */
  inspect(agentId: string, operationId: string, since?: number): Promise<AgentSnapshot>;
  send(agentId: string, operationId: string, prompt: string): Promise<void>;
  stop(agentId: string): Promise<void>;
}

export class Engine {
  private locks = new Map<string, Promise<unknown>>();
  private checks = new Map<string, AbortController>();
  private stopped = false;
  constructor(readonly store: Store, private agents: AgentGateway, private repository: Repository, private now = () => Date.now()) {}
  private async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.locks.set(id, current);
    try { return await current; } finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }
  private event(run: Run, message: string) {
    run.message = message; run.events.push({ time: this.now(), message }); run.events = run.events.slice(-300);
  }
  async create(input: { requestId: string; repository: string; goal: string; settings?: Settings; workspaceId?: string; chat?: Run["chat"] }): Promise<string> {
    // Serialize preparation so concurrent requests cannot switch one checkout
    // to different branches before either run is recorded.
    return this.locked("create", async () => {
      const existing = this.store.findRequest(input.requestId);
      if (existing) return existing.id;
      const settings = SettingsSchema.parse(input.settings ?? this.store.settings());
      const id = createHash("sha256").update(input.requestId).digest("hex").slice(0, 24);
      if (input.workspaceId) {
        const directory = await this.agents.workspaceDirectory(input.workspaceId);
        const source = await realpath(input.repository);
        if (source !== await realpath(directory)) throw new Error("项目路径与当前工作区不一致，请使用当前目录或选择独立工作区");
        if (this.store.unfinishedWorkspaceRuns().some(r => r.workspaceId === input.workspaceId || r.cwd === source)) throw new Error("当前目录已有未结束的 AI 协作任务，请先完成或取消该任务");
        // Untitled Paseo workspaces derive their name from the live branch.
        // Pin the existing display name before prepare() switches that branch.
        await this.agents.retainWorkspaceName(input.workspaceId);
      }
      const workspace = await this.repository.prepare(input.repository, id, Boolean(input.workspaceId));
      const run: Run = { ...workspace, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), id, ...(input.chat ? { chat: input.chat, directorAgentId: input.chat.mainAgentId } : {}), requestId: input.requestId, revision: 0, goal: input.goal, settings, createdAt: this.now(), updatedAt: this.now(), phase: "planning", control: "running", message: `等待${operationLabel(settings, "plan")}制定计划`, planApproved: !settings.requirePlanApproval, tasks: [], operations: [], events: [] };
      this.store.insert(run); return id;
    });
  }
  async close() {
    this.stopped = true;
    for (const controller of this.checks.values()) controller.abort();
    await Promise.allSettled([...this.locks.values()]);
  }
  async tick() {
    if (this.stopped) return;
    const runs = this.store.pending();
    const results = await Promise.allSettled(runs.filter(r => !this.locks.has(r.id)).map(r => this.locked(r.id, () => this.advance(r.id))));
    for (const [index, outcome] of results.entries()) if (outcome.status === "rejected") console.error(`Director run ${runs[index].id}:`, outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
  }
  private hold(run: Run, message: string) { run.control = "needs_attention"; this.event(run, message); this.store.save(run); }
  private current(run: Run) { return run.operations.find(o => o.id === run.activeOperationId); }
  private actor(run: Run, op: Operation): string {
    const role = operationRole(run.settings, op.kind);
    return role === "worker" ? op.taskId! : role === "reviewer" ? REVIEWER_ACTOR : "director";
  }
  private describe(run: Run, op: Operation) {
    const actor = operationLabel(run.settings, op.kind);
    const action = op.kind === "plan" ? "设计" : op.kind === "execute" ? "执行" : op.kind === "final" ? "统一审核" : "审核";
    const title = run.tasks.find(t => t.spec.id === op.taskId)?.spec.title;
    return { actor, action, detail: title ? `：${title}` : "" };
  }
  private enqueue(run: Run, kind: Operation["kind"], taskId?: string, formatRetries = 0) {
    if (run.operations.length - (run.roundOperationOffset ?? 0) >= run.settings.maxAttempts) throw new Error("已达到本轮任务的调用次数上限");
    const task = run.tasks.find(t => t.spec.id === taskId);
    if (kind === "final" && (!run.tasks.length || !run.tasks.every(executionComplete))) throw new Error("全部任务执行完成后才能统一审核");
    const id = randomUUID();
    const role = operationRole(run.settings, kind);
    const op: Operation = { id, kind, taskId, state: "pending", profileId: role === "worker" ? task!.profileId : role === "reviewer" ? run.settings.reviewerProfileId! : run.settings.directorProfileId, agentId: role === "worker" ? task?.agentId : role === "reviewer" ? run.reviewerAgentId : run.directorAgentId, createdAt: this.now(), formatRetries, prompt: buildPrompt(run, kind, id, taskId) };
    if (kind === "final") op.reviewScope = "all_tasks";
    run.operations.push(op); run.activeOperationId = id;
    const { actor, action, detail } = this.describe(run, op);
    this.event(run, `准备交给${actor}${action}${detail}`);
    this.store.save(run);
  }
  private async advance(id: string) {
    let run = this.store.get(id);
    if ((run.migrationConversationId && !run.chat) || run.chat?.recovering) return;
    if (this.stopped || run.phase === "completed" || !["running", "waiting_permission", "canceling"].includes(run.control)) return;
    try {
      let op = this.current(run);
      if (run.control === "canceling") {
        if (op?.state === "creating" && !op.agentId) {
          const ids = await this.agents.find(run.id, op.id);
          for (const agentId of ids) {
            await this.agents.stop(agentId);
            const state = await this.agents.inspect(agentId, op.id, op.createdAt);
            if (state.status === "running" || state.status === "permission") return;
          }
        }
        if (op?.agentId && op.agentId !== run.chat?.mainAgentId) {
          await this.agents.stop(op.agentId);
          const state = await this.agents.inspect(op.agentId, op.id, op.createdAt);
          if (state.status === "running" || state.status === "permission") return;
        }
        run.control = run.stopTarget ?? "canceled";
        this.event(run, run.control === "canceled" ? "已取消；工作区与成果已保留" : "执行超时，已停止；可以检查结果后重试");
        this.store.save(run); return;
      }
      if (run.phase === "awaiting_acceptance") return;
      if (this.now() - (run.roundStartedAt ?? run.createdAt) >= run.settings.runTimeoutMs) {
        run.control = "canceling"; run.stopTarget = "needs_attention"; this.event(run, "已达到任务总时间上限，正在停止"); this.store.save(run); return;
      }
      // Upgrade queued legacy task reviews without discarding a review already
      // sent to an AI. In-flight reviews finish once, then use unified review.
      if (run.phase === "reviewing" && (!op || (op.kind === "review" && ["pending", "ready"].includes(op.state)))) {
        const task = run.tasks.find(task => task.status === "reviewing");
        if (!task || task.result?.status !== "ready_for_review") throw new Error("缺少已执行的任务成果，无法继续后续任务");
        task.status = "executed";
        if (op) op.state = "abandoned";
        run.activeOperationId = undefined; run.phase = "executing";
        this.event(run, "已改为全部任务执行完成后统一审核，继续串行执行后续任务");
        this.store.save(run); return;
      }
      if (!op) {
        await this.repository.assertBranch(run);
        if (run.phase === "planning") this.enqueue(run, "plan");
        else if (run.phase === "executing") {
          const ready = run.tasks.filter(t => t.status === "pending" && t.spec.dependsOn.every(dep => { const dependency = run.tasks.find(d => d.spec.id === dep); return dependency && executionComplete(dependency); }));
          const task = run.dispatchOrder?.map(id => ready.find(t => t.spec.id === id)).find(Boolean) ?? ready[0];
          if (task) run.dispatchOrder = run.dispatchOrder?.filter(id => id !== task.spec.id);
          if (task) { task.status = "executing"; this.enqueue(run, "execute", task.spec.id); }
          else if (run.tasks.length && run.tasks.every(executionComplete)) { run.phase = "final_review"; this.event(run, `全部任务已执行，准备交给${operationLabel(run.settings, "final")}统一审核`); this.store.save(run); }
          else throw new Error("没有可以执行的任务，请检查依赖和状态");
        } else {
          if (run.phase === "final_review" && (!run.tasks.length || !run.tasks.every(executionComplete))) throw new Error("全部任务执行完成后才能统一审核");
          const task = run.phase === "reviewing" ? run.tasks.find(t => t.status === "reviewing") : undefined;
          if (run.phase === "reviewing" && !task) throw new Error("缺少待审核任务");
          const controller = new AbortController(); this.checks.set(id, controller);
          try {
            const evidence = await this.repository.verify(run, controller.signal);
            if (this.stopped) return;
            if (task) task.evidence = evidence; else run.finalEvidence = evidence;
          } finally { this.checks.delete(id); }
          this.enqueue(run, task ? "review" : "final", task?.spec.id);
        }
        return;
      }
      if (op.state === "creating") {
        const ids = await this.agents.find(run.id, op.id);
        if (ids.length !== 1) { this.hold(run, "创建会话的结果不明确，已停止自动重发；请检查后选择重试"); return; }
        this.bindAgent(run, op, ids[0]); this.store.save(run); return;
      }
      if (op.state === "pending") {
        await this.repository.assertBranch(run);
        if (op.agentId) { op.state = "ready"; this.store.save(run); return; }
        op.state = "creating"; this.store.save(run);
        const profile = run.settings.profiles.find(p => p.id === op!.profileId)!;
        const token = this.store.token(run.id, this.actor(run, op));
        const agentId = await this.agents.create(run, op, profile, token);
        this.bindAgent(run, op, agentId); this.store.save(run); return;
      }
      if (!op.agentId) throw new Error("缺少 AI 会话");
      if (op.state === "ready") {
        await this.repository.assertBranch(run);
        const before = await this.agents.inspect(op.agentId, op.id, op.createdAt);
        const { actor, action, detail } = this.describe(run, op);
        if (before.status === "running" || before.status === "permission") {
          const control = before.status === "permission" ? "waiting_permission" : "running";
          const message = before.status === "permission" ? `${actor}等待权限或回答，${action}指令尚未发送；请打开当前 AI 会话处理` : `${actor}仍在完成上一轮，${action}指令尚未发送`;
          if (run.message !== message || run.control !== control) { run.control = control; this.event(run, message); this.store.save(run); }
          return;
        }
        if (before.status === "missing") throw new Error("AI 会话已不存在，请重试以建立替代会话");
        if (before.status === "error") throw new Error(before.error ?? "AI 会话出错，指令尚未发送");
        run.control = "running";
        op.state = "sending"; op.sentAt = this.now(); this.store.save(run);
        await this.agents.send(op.agentId, op.id, op.prompt);
        op.state = "sent"; op.deliveryConfirmedAt = this.now(); this.event(run, `已发送${action}指令，等待${actor}开始${detail}`); this.store.save(run); return;
      }
      const state = await this.agents.inspect(op.agentId, op.id, op.createdAt);
      if (state.status === "missing" || state.status === "error") throw new Error(state.error ?? "AI 会话不可用");
      const conversational = !!run.chat && op.agentId === run.chat.mainAgentId;
      if (state.interrupted && !conversational) throw new Error("此会话收到其他消息，已暂停自动处理；请检查后重试当前步骤");
      if (op.state === "sending") {
        if (!state.seen) { this.hold(run, "无法确认上一条指令是否送达，已停止自动重发；请检查后重试"); return; }
        op.state = "sent"; this.store.save(run);
      }
      if (state.status === "permission") {
        if (run.control !== "waiting_permission") { run.control = "waiting_permission"; this.event(run, `${this.describe(run, op).actor}等待权限或回答，请打开当前 AI 会话处理`); this.store.save(run); }
        return;
      }
      const resumed = run.control === "waiting_permission";
      if (resumed) { run.control = "running"; this.event(run, `权限或提问已处理，继续跟进${this.describe(run, op).actor}本轮结果`); this.store.save(run); }
      if (this.now() - (op.sentAt ?? op.createdAt) >= run.settings.turnTimeoutMs) {
        run.control = "canceling"; run.stopTarget = "needs_attention"; this.event(run, "当前步骤超时，正在停止 AI"); this.store.save(run); return;
      }
      if (state.status === "running" && !(conversational && op.response !== undefined)) {
        if (!op.observedBusy) {
          op.observedBusy = true;
          const { actor, action, detail } = this.describe(run, op);
          if (!resumed && op.response === undefined) this.event(run, `${actor} 正在${action}${detail}`);
          this.store.save(run);
        }
        return;
      }
      if (!state.seen && !(conversational && op.response !== undefined)) { if (this.now() - (op.sentAt ?? op.createdAt) > 20000) throw new Error("当前指令未出现在会话记录中"); return; }
      // A normal reply or canceled chat turn is not an invalid operation result.
      if (conversational && op.response === undefined) return;
      if (op.response === undefined && !state.output.trim()) { if (this.now() - (op.sentAt ?? op.createdAt) > 20000) throw new Error("本轮没有返回任务结果"); return; }
      let response: unknown;
      try { response = responseSchema(op.kind).parse(op.response ?? parseOutput(state.output)); }
      catch (error) {
        if (op.formatRetries >= 2) throw new Error(`结果格式连续无效：${String(error).slice(0, 1200)}`);
        op.state = "abandoned"; run.activeOperationId = undefined;
        this.enqueue(run, op.kind, op.taskId, op.formatRetries + 1);
        const replacement = this.current(run)!;
        replacement.prompt += `\n上一轮结果格式错误，请补交正确格式，不要重复实施已完成的修改。错误：${String(error).slice(0, 2000)}`;
        this.store.save(run); return;
      }
      await this.finish(run, op, response);
    } catch (error) {
      // Re-read after a failed compare-and-swap rather than overwriting another control action.
      run = this.store.get(id);
      if (!this.stopped && run.control !== "canceled" && run.phase !== "completed") this.hold(run, String(error instanceof Error ? error.message : error).slice(0, 3000));
    }
  }
  private bindAgent(run: Run, op: Operation, agentId: string) {
    op.agentId = agentId; op.state = "ready";
    this.setSession(run, op, agentId);
  }
  private setSession(run: Run, op: Operation, agentId?: string) {
    const role = operationRole(run.settings, op.kind);
    if (role === "worker") run.tasks.find(t => t.spec.id === op.taskId)!.agentId = agentId;
    else if (role === "reviewer") run.reviewerAgentId = agentId;
    else if (!run.chat || agentId === run.chat.mainAgentId) run.directorAgentId = agentId;
  }
  private async finish(run: Run, op: Operation, value: unknown) {
    if (op.kind === "plan") {
      const plan = PlanSchema.parse(value); validatePlan(plan, run.settings);
      const changes = run.changeRequests?.at(-1);
      run.plan = plan; run.tasks = plan.tasks.map(spec => {
        const profileId = profileForTask(run.settings, spec);
        const previous = changes && changes.planVersion === run.planVersion ? changes.previousTasks.find(t => t.id === spec.id && t.profileId === profileId) : undefined;
        return { spec, profileId, status: "pending", reworks: 0, agentId: previous?.agentId };
      });
      run.phase = "executing";
      if (!run.planApproved) run.control = "paused";
      this.event(run, run.planApproved ? "总纲已保存，开始按依赖执行" : "总纲已生成，等待查看并批准");
    } else if (op.kind === "execute") {
      const result = ResultSchema.parse(value), task = run.tasks.find(t => t.spec.id === op.taskId)!;
      task.result = result;
      if (result.status === "blocked") { this.hold(run, `执行受阻：${result.summary}`); return; }
      task.status = "executed"; run.phase = "executing";
      this.event(run, `执行完成：${task.spec.title}；全部任务完成后统一审核`);
    } else {
      const review = ReviewSchema.parse(value), task = run.tasks.find(t => t.spec.id === op.taskId);
      const evidence = op.kind === "final" ? run.finalEvidence! : task!.evidence!;
      if (review.artifactId !== evidence.id || (await this.repository.capture(run)).id !== evidence.id) throw new Error("审核版本与当前成果不一致，需重新验证后审核");
      const criteria = op.kind === "final" ? op.reviewScope === "all_tasks" ? finalAcceptance(run.plan!) : run.plan!.acceptance : task!.spec.acceptance;
      if (review.decision === "approved") {
        if (op.kind === "final" && (!run.tasks.length || !run.tasks.every(executionComplete))) throw new Error("仍有任务未执行完成，不能批准成果");
        if (run.settings.verificationCommands.length && !evidence.passed) throw new Error("用户指定的额外检查未通过，不能批准成果");
        if (criteria.some(c => !review.criteria.some(r => r.criterion === c && r.passed && r.evidence.trim()))) throw new Error("审核未覆盖全部原始验收标准");
      }
      if (task) task.review = review; else run.finalReview = review;
      if (review.decision === "blocked") { this.hold(run, `审核受阻：${review.summary}`); return; }
      if (review.decision === "changes_requested") this.rework(run, review);
      else if (task) { task.status = "approved"; run.phase = "executing"; this.event(run, `审核通过：${task.spec.title}`); }
      else { for (const task of run.tasks) task.status = "approved"; run.phase = "awaiting_acceptance"; run.control = "paused"; this.event(run, `${operationLabel(run.settings, "final")}统一审核通过，等待你验收或提出修改意见`); }
    }
    op.response = value; op.state = "done"; op.completedAt = this.now(); run.activeOperationId = undefined; this.store.save(run);
  }
  private rework(run: Run, review: Review) {
    const ids = new Set(review.findings.map(f => f.taskId));
    for (const id of ids) {
      const task = run.tasks.find(t => t.spec.id === id);
      if (!task) throw new Error(`审核引用未知任务：${id}`);
      if (task.reworks >= run.settings.maxReworks) throw new Error(`任务 ${id} 已达到返工次数上限`);
    }
    // Changing an accepted dependency invalidates all downstream acceptances.
    const invalid = new Set(ids);
    let changed = true;
    while (changed) { changed = false; for (const t of run.tasks) if (!invalid.has(t.spec.id) && t.spec.dependsOn.some(d => invalid.has(d))) { invalid.add(t.spec.id); changed = true; } }
    for (const task of run.tasks) if (invalid.has(task.spec.id)) {
      task.status = "pending"; task.evidence = undefined; task.review = undefined;
      if (ids.has(task.spec.id)) { task.reworks++; task.feedback = JSON.stringify(review.findings.filter(f => f.taskId === task.spec.id)); }
      else task.feedback = "前置任务发生变更，请重新检查实现与集成兼容性";
    }
    // If a task review requests changes in a dependency, also reschedule the current task.
    const currentTask = run.tasks.find(t => t.status === "reviewing");
    if (currentTask) { currentTask.status = "pending"; currentTask.evidence = undefined; }
    run.finalEvidence = undefined; run.finalReview = undefined; run.phase = "executing";
    this.event(run, `需要返工：${[...ids].join("、")}`);
  }
  async submit(runId: string, actor: string, operationId: string, payload: unknown) {
    return this.locked(runId, async () => {
      const run = this.store.get(runId), op = this.current(run);
      const conversational = !!op && !!run.chat && op.agentId === run.chat.mainAgentId;
      if (!op || op.id !== operationId || !["running", "waiting_permission", "paused"].includes(run.control) || !(conversational ? ["pending", "ready", "sending", "sent"] : ["sending", "sent"]).includes(op.state)) throw new Error("提交对应的步骤已经结束");
      if (actor !== this.actor(run, op)) throw new Error("角色无权提交此步骤");
      const response = responseSchema(op.kind).parse(payload);
      const hash = createHash("sha256").update(JSON.stringify(response)).digest("hex");
      if (op.responseHash && op.responseHash !== hash) throw new Error("本轮已提交不同结果");
      if (!op.responseHash) {
        if (conversational) op.state = "sent";
        op.response = response; op.responseHash = hash;
        this.event(run, `已收到${this.describe(run, op).actor}提交的结果，等待本轮结束后校验`);
        this.store.save(run);
      }
      return { accepted: true };
    });
  }
  async markMigration(id: string, conversationId: string) {
    return this.locked(id, async () => {
      const run = this.store.get(id);
      if (run.chat || run.migrationConversationId === conversationId) return;
      run.migrationConversationId = conversationId;
      this.store.save(run);
    });
  }
  async attachConversation(id: string, conversationId: string, mainAgentId: string) {
    return this.locked(id, async () => {
      const run = this.store.get(id);
      if (run.chat) {
        if (run.chat.conversationId !== conversationId) throw new Error("任务已绑定其他主会话");
        return;
      }
      const old = run.directorAgentId;
      run.chat = { version: 1, conversationId, mainAgentId, legacyAgentId: old };
      run.directorAgentId = mainAgentId;
      // Already-created operations retain their agent and protocol. Only future
      // operations use the main chat; never resend an in-flight operation.
      const op = this.current(run);
      if (op?.kind === "plan" && op.state === "pending" && !op.agentId) op.agentId = mainAgentId;
      run.migrationConversationId = undefined;
      this.store.save(run);
    });
  }
  async recoverMain(id: string, agentId?: string) {
    return this.locked(id, async () => {
      const run = this.store.get(id);
      if (!run.chat) throw new Error("任务尚未迁入主对话");
      if (!agentId) run.chat.recovering = true;
      else {
        const old = run.chat.mainAgentId;
        const op = this.current(run);
        if (op?.agentId === old) { op.state = "abandoned"; run.activeOperationId = undefined; }
        run.chat.mainAgentId = agentId; run.chat.recovering = false; run.directorAgentId = agentId;
      }
      this.store.save(run);
    });
  }
  async dispatch(id: string, taskId: string) {
    return this.locked(id, async () => {
      const run = this.store.get(id);
      if (run.control !== "running" || !["planning", "executing"].includes(run.phase)) throw new Error("当前状态不能派发新任务");
      const draft = run.plan ?? PlanSchema.parse(this.current(run)?.response);
      validatePlan(draft, run.settings);
      const spec = draft.tasks.find(t => t.id === taskId);
      if (!spec) throw new Error("任务不在已提交的总纲中");
      const task = run.tasks.find(t => t.spec.id === taskId);
      if (task && task.status !== "pending") throw new Error("任务已派发或已通过");
      run.dispatchOrder = [...new Set([...(run.dispatchOrder ?? []), taskId])];
      this.store.save(run);
      return { taskId, executorId: profileForTask(run.settings, spec), queued: true, note: "当前轮结束且前置任务执行完成后串行执行，全部完成后统一审核" };
    });
  }
  private async finalControl(run: Run, action: ControlAction, input: FinalControl, receipt?: string) {
    if (!hasFinalResult(run) || !run.plan || !run.tasks.length || run.tasks.some(t => t.status !== "approved")) throw new Error("当前没有可验收的最终成果");
    if (input.expectedRevision !== run.revision || input.artifactId !== run.finalEvidence!.id || run.finalReview!.artifactId !== run.finalEvidence!.id) throw new Error("任务或审核版本已变化，请刷新后重试");
    if (action !== "request_changes" && run.userAcceptance) throw new Error("该成果已经验收，请刷新查看");
    if (action === "reject_final") {
      run.userAcceptance = { decision: "rejected", artifactId: run.finalEvidence!.id, decidedAt: this.now() };
      run.control = "canceled"; this.event(run, "你选择不采纳并结束任务；文件和分支已保留");
    } else if (action === "accept_final") {
      await this.repository.assertBranch(run);
      if ((await this.repository.capture(run)).id !== run.finalEvidence!.id) throw new Error("代码已在最终审核后发生变化，请提交修改意见，让团队重新审核当前成果");
      run.userAcceptance = { decision: "approved", artifactId: run.finalEvidence!.id, decidedAt: this.now() };
      run.phase = "completed"; run.control = "running"; this.event(run, "你已验收通过，任务完成；文件和分支已保留");
    } else {
      const feedback = input.feedback?.trim();
      if (!feedback || feedback.length > 16000) throw new Error("请填写修改意见（最多 16000 字）");
      if (this.store.unfinishedWorkspaceRuns().some(r => r.id !== run.id && (r.cwd === run.cwd || (!!run.workspaceId && r.workspaceId === run.workspaceId)))) throw new Error("当前目录已有其他未结束的任务，请先完成或取消该任务");
      await this.repository.assertBranch(run);
      run.planVersion = (run.planVersion ?? 1) + 1;
      run.changeRequests = [...(run.changeRequests ?? []), {
        requestedAt: this.now(), feedback, planVersion: run.planVersion, artifactId: run.finalEvidence!.id,
        previousPlan: run.plan, previousReview: run.finalReview!, previousAcceptance: run.userAcceptance,
        previousTasks: run.tasks.map(t => ({ id: t.spec.id, profileId: t.profileId, agentId: t.agentId, result: t.result })),
      }];
      run.roundStartedAt = this.now(); run.roundOperationOffset = run.operations.length;
      run.plan = undefined; run.tasks = []; run.finalEvidence = undefined; run.finalReview = undefined; run.userAcceptance = undefined; run.dispatchOrder = [];
      run.planApproved = !run.settings.requirePlanApproval; run.planApprovedAt = undefined;
      run.phase = "planning"; run.control = "running";
      this.event(run, `修改意见已提交，${operationLabel(run.settings, "plan")}将安排修改；保留原目标和现有文件`);
    }
    if (receipt) (run.chatReceipts ??= {})[receipt] = action;
    this.store.save(run); return { ok: true };
  }
  async control(id: string, action: ControlAction, goal?: string, final: FinalControl = {}, receipt?: string) {
    if (action === "cancel" || action === "revise") this.checks.get(id)?.abort();
    const apply = () => this.locked(id, async () => {
      const run = this.store.get(id);
      if (receipt && run.chatReceipts?.[receipt] === action) return { ok: true };
      if (["accept_final", "reject_final", "request_changes"].includes(action)) return this.finalControl(run, action, final, receipt);
      if (run.phase === "completed" || run.control === "canceled") throw new Error("任务已结束");
      if (run.phase === "awaiting_acceptance" && action !== "cancel") throw new Error("AI 已审核通过，请验收成果或提交修改意见");
      if (action === "pause") { run.control = "paused"; this.event(run, "已暂停后续派发；当前 AI 可完成本轮"); }
      if (action === "cancel") { run.control = "canceling"; run.stopTarget = "canceled"; this.event(run, "正在停止当前执行"); }
      if (action === "approve_plan") {
        if (!run.plan || run.planApproved) throw new Error("没有待批准的总纲");
        run.planApproved = true; run.planApprovedAt = this.now(); run.control = "running"; this.event(run, "总纲已批准");
      }
      if (action === "resume") {
        if (!run.planApproved && run.plan) throw new Error("请先批准总纲");
        if (!canResumeRun(run)) throw new Error("请使用检查后重试，避免重复发送未确认的指令");
        run.control = "running"; this.event(run, "继续执行");
      }
      if (action === "retry") {
        if (run.control !== "needs_attention") throw new Error("仅受阻任务可以重试");
        if (this.now() - (run.roundStartedAt ?? run.createdAt) >= run.settings.runTimeoutMs) throw new Error("本轮任务总时间预算已耗尽，请创建新任务");
        await this.repository.assertBranch(run);
        const op = this.current(run);
        let outputError: string | undefined;
        if (op?.state === "creating" && !op.agentId) {
          const ids = await this.agents.find(run.id, op.id);
          if (ids.length > 1) throw new Error("发现多个可能的执行会话，请先在 Paseo 中核对");
          if (ids.length === 1) this.bindAgent(run, op, ids[0]);
        }
        if (op?.agentId) {
          const state = await this.agents.inspect(op.agentId, op.id, op.createdAt);
          if (["running", "permission"].includes(state.status)) throw new Error("原 AI 仍在执行或等待权限，请先在 Paseo 中处理");
          // Recover valid completed work after an adapter fix, without another
          // AI turn. Interrupted or blocked work still takes the retry path.
          if (state.status === "idle" && state.seen && !state.interrupted && ["sent", "sending"].includes(op.state) && ["plan", "execute"].includes(op.kind)) {
            let response: unknown;
            try {
              const candidate = responseSchema(op.kind).parse(op.response ?? parseOutput(state.output));
              if (op.kind === "plan") validatePlan(PlanSchema.parse(candidate), run.settings);
              response = candidate;
            } catch (error) { outputError = String(error).slice(0, 2000); }
            if (response && (op.kind === "plan" || ResultSchema.parse(response).status === "ready_for_review")) {
              run.control = "running";
              await this.finish(run, op, response);
              return { ok: true };
            }
          }
          if (state.status === "missing" || state.status === "error") {
            if (op.agentId === run.chat?.mainAgentId) throw new Error("主会话不可用，请先在 Paseo 中恢复原主对话，再重试当前步骤");
            // Retain the failed operation, but create the retry session from
            // the saved profile instead of reusing an unusable agent.
            this.setSession(run, op);
          }
        }
        run.control = "running";
        if (op) {
          op.state = "abandoned"; run.activeOperationId = undefined;
          if (op.kind === "review" || op.kind === "final") {
            run.phase = op.kind === "review" ? "reviewing" : "final_review";
          } else {
            this.enqueue(run, op.kind, op.taskId, op.formatRetries);
            if (outputError) this.current(run)!.prompt += `\n上一轮结果无效，请修正后重新提交，不要重复实施已完成的修改。错误：${outputError}`;
          }
        }
        this.event(run, "用户检查后重试当前步骤");
      }
      if (action === "revise") {
        if (!["paused", "needs_attention"].includes(run.control)) throw new Error("请先暂停任务，再修改要求");
        if (!goal?.trim()) throw new Error("新目标不能为空");
        const op = this.current(run);
        if (op?.state === "creating" && !op.agentId) throw new Error("请先检查创建中的会话并重试，再修改需求");
        if (op?.agentId && op.agentId !== run.chat?.mainAgentId) {
          await this.agents.stop(op.agentId);
          const state = await this.agents.inspect(op.agentId, op.id, op.createdAt);
          if (["running", "permission"].includes(state.status)) throw new Error("正在停止原 AI，请稍后保存新要求");
        }
        if (op) op.state = "abandoned";
        run.activeOperationId = undefined; run.goal = goal.trim(); run.planVersion = (run.planVersion ?? 1) + 1;
        run.plan = undefined; run.tasks = []; run.finalEvidence = undefined; run.finalReview = undefined; run.dispatchOrder = [];
        run.planApproved = !run.settings.requirePlanApproval; run.planApprovedAt = undefined; run.phase = "planning"; run.control = "running";
        this.event(run, `需求已更新为第 ${run.planVersion} 版，保留现有代码，重新设计并验收`);
      }
      this.store.save(run); return { ok: true };
    });
    // Reopening an old result must not race with creation in the same checkout.
    return action === "request_changes" ? this.locked("create", apply) : apply();
  }
}
