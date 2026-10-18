import { describe, expect, it } from "vitest";
import { Jobs } from "./jobs";

describe("long Magpie operations", () => {
  it("returns immediately and reports the eventual success", async () => {
    const jobs = new Jobs();
    let finish!: (value: { notice: string }) => void;
    const pending = new Promise<{ notice: string }>((resolve) => {
      finish = resolve;
    });
    const started = jobs.start(() => pending);
    expect(jobs.read(started.jobId).state).toBe("running");
    finish({ notice: "已安装" });
    await expect.poll(() => jobs.read(started.jobId).state).toBe("done");
    expect(jobs.read(started.jobId).notice).toBe("已安装");
  });
  it("reports failures and clears records when the plugin unloads", async () => {
    const jobs = new Jobs();
    const started = jobs.start(async () => {
      throw new Error("安装失败");
    });
    await expect.poll(() => jobs.read(started.jobId).state).toBe("failed");
    expect(jobs.read(started.jobId).error).toBe("安装失败");
    jobs.clear();
    expect(() => jobs.read(started.jobId)).toThrow("已过期");
  });
});
