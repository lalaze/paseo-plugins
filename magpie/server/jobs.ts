import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { jobSchema } from "../shared/rpc";

type Job = z.infer<typeof jobSchema>;
export class Jobs {
  private jobs = new Map<string, { status: Job; at: number }>();
  start(work: () => Promise<{ notice: string; data?: Job["data"] }>) {
    for (const [id, job] of this.jobs)
      if (job.status.state !== "running" && Date.now() - job.at > 15 * 60_000) this.jobs.delete(id);
    const id = randomUUID();
    const job = { status: jobSchema.parse({ state: "running" }), at: Date.now() };
    this.jobs.set(id, job);
    void Promise.resolve()
      .then(work)
      .then(
        (result) => {
          job.status = jobSchema.parse({ state: "done", notice: result.notice, data: result.data });
        },
        (error: unknown) => {
          job.status = jobSchema.parse({
            state: "failed",
            error: error instanceof Error ? error.message : "Magpie 操作失败。",
          });
        },
      );
    return { jobId: id, notice: "Magpie 正在主机上执行操作，请稍候…" };
  }
  read(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("操作记录已过期，请刷新页面检查结果。");
    return job.status;
  }
  clear() {
    this.jobs.clear();
  }
}
