import { describe, expect, it, vi } from "vitest";
import {
  DesktopCompletionMonitor,
  classifyCompletionDeliveryError,
  redactSecrets,
  splitCompletionNotification,
  summarizeCompletionResult,
  type DesktopCompletionPoll,
  type DesktopCompletionSnapshot
} from "../../packages/orchestrator/src/desktop-completion-monitor.js";

function snapshot(overrides: Partial<DesktopCompletionSnapshot> = {}): DesktopCompletionSnapshot {
  return {
    threadId: "thread-main",
    turnId: "turn-1",
    responseId: "turn-1:msg-old",
    responseText: "old",
    responseHash: "hash-old",
    title: "Main task",
    projectName: "project",
    isRunning: false,
    isTopLevel: true,
    observedAt: "2026-08-16T03:00:00.000Z",
    ...overrides
  };
}

class FakeRepository {
  target: { sessionKey: string; accountKey: string } | null = {
    sessionKey: "qqbot:default::qq:c2c:OPENID",
    accountKey: "qqbot:default"
  };
  origin: "qq" | null = null;
  notifications = new Map<string, any>();

  resolveDefaultTarget() {
    return this.target;
  }

  consumeTurnOrigin() {
    const origin = this.origin;
    this.origin = null;
    return origin;
  }

  reserveNotification(input: any) {
    if (this.notifications.has(input.completionKey)) {
      return false;
    }
    this.notifications.set(input.completionKey, {
      ...input,
      status: input.origin === "qq" ? "suppressed" : "pending",
      attemptCount: 0,
      parts: (input.notificationParts ?? (input.notificationText ? [input.notificationText] : []))
        .map((text: string, partIndex: number, all: string[]) => ({
          text,
          partIndex,
          partCount: all.length,
          status: "pending",
          attemptCount: 0
        }))
    });
    return true;
  }

  listDue() {
    return [...this.notifications.values()]
      .flatMap((row) => {
        if (row.status !== "pending" && row.status !== "retry_wait") {
          return [];
        }
        const part = row.parts.find((candidate: any) => candidate.status !== "sent");
        return part ? [{
          completionKey: row.completionKey,
          threadId: row.threadId,
          turnId: row.turnId,
          responseId: row.responseId,
          responseHash: row.responseHash,
          targetSessionKey: row.targetSessionKey,
          notificationText: part.text,
          attemptCount: part.attemptCount,
          partIndex: part.partIndex,
          partCount: part.partCount
        }] : [];
      });
  }

  markSent(key: string, partIndex: number) {
    const row = this.notifications.get(key);
    const part = row.parts[partIndex];
    part.status = "sent";
    part.attemptCount += 1;
    row.status = row.parts.every((candidate: any) => candidate.status === "sent") ? "sent" : "pending";
  }

  markFailed(input: any) {
    const row = this.notifications.get(input.completionKey);
    const part = row.parts[input.partIndex];
    part.attemptCount += 1;
    part.status = input.permanent || part.attemptCount >= input.maxAttempts ? "dead" : "retry_wait";
    row.attemptCount = part.attemptCount;
    row.status = part.status;
  }
}

function harness(options: { repo?: FakeRepository; deliver?: ReturnType<typeof vi.fn> } = {}) {
  let current: DesktopCompletionPoll = {
    active: snapshot(),
    topLevelThreadIds: ["thread-main"]
  };
  let error: Error | null = null;
  let nowMs = Date.parse("2026-08-16T03:00:00.000Z");
  const repo = options.repo ?? new FakeRepository();
  const deliver = options.deliver ?? vi.fn().mockResolvedValue({ providerMessageId: "qq-1" });
  const monitor = new DesktopCompletionMonitor(
    {
      readCompletionPoll: async () => {
        if (error) {
          throw error;
        }
        return current;
      }
    },
    repo as any,
    { "qqbot:default": { deliverProactive: deliver } },
    {
      stabilityWindowMs: 100,
      now: () => new Date(nowMs),
      logger: { info: vi.fn(), warn: vi.fn() }
    }
  );
  return {
    monitor,
    repo,
    deliver,
    set(value: Partial<DesktopCompletionSnapshot>) {
      current = { ...current, active: snapshot(value) };
    },
    setPoll(value: DesktopCompletionPoll) {
      current = value;
    },
    advance(ms: number) {
      nowMs += ms;
    },
    fail(value: Error | null) {
      error = value;
    }
  };
}

async function complete(h: ReturnType<typeof harness>, final: Partial<DesktopCompletionSnapshot> = {}) {
  await h.monitor.pollOnce();
  h.advance(10);
  h.set({ isRunning: true });
  await h.monitor.pollOnce();
  h.advance(10);
  h.set({
    isRunning: false,
    responseId: "turn-1:msg-final",
    responseHash: "hash-final",
    responseText: "final result",
    ...final
  });
  await h.monitor.pollOnce();
  h.advance(150);
  await h.monitor.pollOnce();
}

describe("desktop completion monitor", () => {
  it("uses startup and restart baselines without notifying historical completions", async () => {
    const repo = new FakeRepository();
    const first = harness({ repo });
    await first.monitor.pollOnce();
    await first.monitor.pollOnce();
    expect(first.deliver).not.toHaveBeenCalled();

    const restarted = harness({ repo });
    restarted.set({ responseId: "turn-old:msg-final", responseHash: "historical" });
    await restarted.monitor.pollOnce();
    await restarted.monitor.pollOnce();
    expect(restarted.deliver).not.toHaveBeenCalled();
  });

  it("waits through idle, busy, streaming changes and a stability window, then sends exactly once", async () => {
    const h = harness();
    await h.monitor.pollOnce();
    h.set({ isRunning: true });
    await h.monitor.pollOnce();
    h.set({ isRunning: true, responseId: "turn-1:msg-stream", responseHash: "stream-1" });
    await h.monitor.pollOnce();
    h.set({ isRunning: true, responseId: "turn-1:msg-stream", responseHash: "stream-2" });
    await h.monitor.pollOnce();
    expect(h.deliver).not.toHaveBeenCalled();
    h.set({ isRunning: false, responseId: "turn-1:msg-final", responseHash: "final", responseText: "done" });
    await h.monitor.pollOnce();
    expect(h.deliver).not.toHaveBeenCalled();
    h.advance(150);
    await h.monitor.pollOnce();
    await h.monitor.pollOnce();
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it("ignores worker and multiple subagent completions while notifying the top-level main completion once", async () => {
    const h = harness();
    await h.monitor.pollOnce();
    h.setPoll({ active: snapshot({ threadId: "worker-1", isTopLevel: false, isRunning: false }), topLevelThreadIds: ["thread-main"] });
    await h.monitor.pollOnce();
    h.setPoll({ active: snapshot({ threadId: "worker-2", isTopLevel: false, isRunning: false }), topLevelThreadIds: ["thread-main"] });
    await h.monitor.pollOnce();
    expect(h.deliver).not.toHaveBeenCalled();
    h.setPoll({ active: snapshot(), topLevelThreadIds: ["thread-main"] });
    await complete(h);
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it("suppresses a QQ-originated correlated turn but sends a Desktop-originated turn", async () => {
    const qq = harness();
    qq.repo.origin = "qq";
    await complete(qq);
    expect(qq.deliver).not.toHaveBeenCalled();
    expect([...qq.repo.notifications.values()][0]?.status).toBe("suppressed");

    const desktop = harness();
    await complete(desktop);
    expect(desktop.deliver).toHaveBeenCalledTimes(1);
  });

  it("always sends completion notifications through the explicit proactive path", async () => {
    const h = harness();
    await complete(h);

    expect(h.deliver).toHaveBeenCalledWith(expect.objectContaining({
      draftId: expect.stringMatching(/^desktop-completion:/),
      sessionKey: "qqbot:default::qq:c2c:OPENID",
      text: expect.stringContaining("Codex 任务完成")
    }));
    const draft = h.deliver.mock.calls[0]?.[0];
    expect(Object.hasOwn(draft, "replyToMessageId")).toBe(false);
  });

  it("persists ordered long-result progress and retries only the failed part", async () => {
    const deliver = vi.fn()
      .mockResolvedValueOnce({ providerMessageId: "qq-part-1" })
      .mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))
      .mockResolvedValue({ providerMessageId: "qq-next" });
    const h = harness({ deliver });
    const longResult = [
      "# 中文结果",
      "",
      "- 自动测试：PASS",
      "- 构建：PASS",
      "",
      "```ts",
      `const report = ${JSON.stringify("长内容".repeat(2_600))};`,
      "```"
    ].join("\n");

    await complete(h, { responseText: longResult });
    const row = [...h.repo.notifications.values()][0];
    expect(row.parts.length).toBeGreaterThan(1);
    expect(deliver).toHaveBeenCalledTimes(1);

    await h.monitor.pollOnce();
    expect(deliver).toHaveBeenCalledTimes(2);
    h.advance(6_000);
    await h.monitor.pollOnce();
    expect(deliver).toHaveBeenCalledTimes(3);

    for (let index = 0; index < row.parts.length + 1; index += 1) {
      await h.monitor.pollOnce();
    }

    const sentTexts = deliver.mock.calls.map((call) => String(call[0].text));
    expect(sentTexts[0]).toContain(`1/${row.parts.length}`);
    expect(sentTexts[1]).toContain(`2/${row.parts.length}`);
    expect(sentTexts[2]).toBe(sentTexts[1]);
    expect(sentTexts.filter((text) => text === sentTexts[0])).toHaveLength(1);
    expect(row.status).toBe("sent");
  });

  it("fails open when the target is missing or QQ delivery fails", async () => {
    const missing = harness();
    missing.repo.target = null;
    await expect(complete(missing)).resolves.toBeUndefined();
    expect(missing.deliver).not.toHaveBeenCalled();

    const failure = harness({ deliver: vi.fn().mockRejectedValue(new Error("Bearer secret-token")) });
    await expect(complete(failure)).resolves.toBeUndefined();
    expect(failure.monitor.getHealth().running).toBe(false);
    expect([...failure.repo.notifications.values()][0]?.status).toBe("dead");
  });

  it("marks QQ 40034024 and generic HTTP 400 as permanent after one attempt", async () => {
    for (const error of [
      Object.assign(new Error("invalid/unauthorized msg_id"), { httpStatus: 400, businessCode: 40034024 }),
      Object.assign(new Error("invalid request"), { httpStatus: 400 })
    ]) {
      const h = harness({ deliver: vi.fn().mockRejectedValue(error) });
      await complete(h);
      h.advance(60_000);
      await h.monitor.pollOnce();

      const row = [...h.repo.notifications.values()][0];
      expect(h.deliver).toHaveBeenCalledTimes(1);
      expect(row?.attemptCount).toBe(1);
      expect(row?.status).toBe("dead");
    }
  });

  it("retries timeout and HTTP 5xx failures only up to the configured limit", async () => {
    for (const error of [
      Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }),
      Object.assign(new Error("service unavailable"), { httpStatus: 503 })
    ]) {
      const h = harness({ deliver: vi.fn().mockRejectedValue(error) });
      await complete(h);
      h.advance(6_000);
      await h.monitor.pollOnce();
      h.advance(11_000);
      await h.monitor.pollOnce();
      h.advance(121_000);
      await h.monitor.pollOnce();

      const row = [...h.repo.notifications.values()][0];
      expect(h.deliver).toHaveBeenCalledTimes(3);
      expect(row?.attemptCount).toBe(3);
      expect(row?.status).toBe("dead");
    }
  });

  it("classifies only bounded transient failures as retryable", () => {
    expect(classifyCompletionDeliveryError({ httpStatus: 429, retryAfterMs: 2_000 })).toEqual({
      retryable: true,
      retryAfterMs: 2_000
    });
    expect(classifyCompletionDeliveryError({ httpStatus: 503 }).retryable).toBe(true);
    expect(classifyCompletionDeliveryError({ httpStatus: 403 }).retryable).toBe(false);
    expect(classifyCompletionDeliveryError(new Error("unknown failure")).retryable).toBe(false);
  });

  it("recovers after temporary CDP and monitor exceptions", async () => {
    const h = harness();
    h.fail(new Error("CDP unavailable"));
    await expect(h.monitor.pollOnce()).resolves.toBeUndefined();
    expect(h.monitor.getHealth().healthy).toBe(false);
    h.fail(null);
    await h.monitor.pollOnce();
    expect(h.monitor.getHealth().healthy).toBe(true);
  });

  it("redacts secrets, preserves readable markdown and marks the total cap", () => {
    const secret = "QQBOT_APPSECRET=hunter2 Authorization: abc Bearer token-value sk-12345678901234567890";
    const redacted = redactSecrets(secret);
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("token-value");
    expect(redacted).not.toContain("sk-123");
    const summary = summarizeCompletionResult(`# Result\n\n- ${"长".repeat(1_000)}`, 800);
    expect(summary).toContain("# Result");
    expect(summary).toContain("- 长");
    expect(summary.length).toBe(800);
    expect(summary).toContain("其余内容已省略");
  });

  it("keeps short results in one message and makes long Markdown parts readable", () => {
    expect(splitCompletionNotification("✅ Codex 任务完成\n\n结果：\n短结果")).toHaveLength(1);

    const parts = splitCompletionNotification([
      "✅ Codex 任务完成",
      "",
      "结果：",
      "# 测试摘要",
      "- 中文：通过",
      "```powershell",
      `Write-Output ${JSON.stringify("代码".repeat(2_500))}`,
      "```"
    ].join("\n"), 1_000);
    expect(parts.length).toBeGreaterThan(1);
    for (const [index, part] of parts.entries()) {
      expect(part.length).toBeLessThanOrEqual(1_000);
      expect(part).toContain(`${index + 1}/${parts.length}`);
      expect((part.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });
});

