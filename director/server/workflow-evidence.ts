import { ReviewSchema, type Run } from "../shared/schema";

const timestamp = (value?: number) => value === undefined ? null : new Date(value).toISOString();

/** Project scheduler-owned checkpoints; never expose prompts, MCP tokens or credentials. */
export function workflowEvidence(run: Run) {
  const planIndex = run.operations.findLastIndex(op => op.kind === "plan" && op.state === "done");
  const operations = run.operations.slice(Math.max(0, planIndex));
  const planStartedAt = operations[0]?.createdAt ?? run.createdAt;
  const events = run.events.filter(event => event.time >= planStartedAt);
  const legacyApproval = events.findLast(event => event.message === "总纲已批准");
  const userApprovedAt = run.settings.requirePlanApproval && run.planApproved
    ? run.planApprovedAt ?? legacyApproval?.time : undefined;
  return {
    source: "Paseo Director 持久化调度记录",
    runId: run.id,
    planVersion: run.planVersion ?? 1,
    planApproval: {
      required: run.settings.requirePlanApproval, approved: run.planApproved,
      userApprovedAt: timestamp(userApprovedAt),
      timestampSource: userApprovedAt === undefined ? "unavailable" : run.planApprovedAt !== undefined ? "checkpoint" : "legacy_event",
    },
    operations: operations.map(op => {
      const review = ["review", "final"].includes(op.kind) && op.state === "done" ? ReviewSchema.safeParse(op.response) : undefined;
      return {
        operationId: op.id, kind: op.kind, taskId: op.taskId ?? null, profileId: op.profileId, agentId: op.agentId ?? null, state: op.state,
        queuedAt: timestamp(op.createdAt), sendRequestedAt: timestamp(op.sentAt),
        deliveryConfirmedAt: timestamp(op.deliveryConfirmedAt), resultAcceptedAt: timestamp(op.completedAt),
        reviewDecision: review?.success ? review.data.decision : null,
        artifactId: review?.success ? review.data.artifactId : null,
      };
    }),
    // Old versions retained milestone times in the event log. Keep those facts
    // available without inventing missing checkpoint timestamps for old runs.
    events: events.filter(event => event.message === "总纲已批准" || event.message.startsWith("审核通过：") || event.message.startsWith("已发送") || event.message.startsWith("执行完成"))
      .map(event => ({ time: timestamp(event.time), message: event.message })),
  };
}
