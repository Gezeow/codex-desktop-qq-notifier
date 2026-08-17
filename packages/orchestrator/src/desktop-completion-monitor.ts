import { createHash } from "node:crypto";
import path from "node:path";
import type { OutboundDraft } from "../../domain/src/message.js";
import type {
  CompletionNotificationRecord,
  SqliteCompletionRepository
} from "../../store/src/completion-repo.js";

export type DesktopCompletionSnapshot = {
  threadId: string;
  turnId: string | null;
  responseId: string | null;
  responseText: string | null;
  responseHash: string;
  title: string | null;
  projectName: string | null;
  isRunning: boolean;
  isTopLevel: boolean;
  observedAt: string;
};

export type DesktopCompletionPoll = {
  active: DesktopCompletionSnapshot | null;
  topLevelThreadIds: string[];
};

export type DesktopCompletionMonitorHealth = {
  running: boolean;
  initialized: boolean;
  healthy: boolean;
  targetConfigured: boolean;
  lastPollAt: string | null;
  lastCompletionAt: string | null;
  lastError: string | null;
};

type ThreadState = {
  phase: "baseline-running" | "idle" | "running" | "candidate";
  baselineResponseId: string | null;
  baselineResponseHash: string;
  runEpoch: string | null;
  candidateResponseId: string | null;
  candidateHash: string | null;
  candidateSinceMs: number | null;
};

type MonitorOptions = {
  pollIntervalMs?: number;
  stabilityWindowMs?: number;
  maxAttempts?: number;
  now?: () => Date;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  logger?: Pick<Console, "info" | "warn">;
};

type CompletionEgress = {
  deliverProactive(
    draft: Omit<OutboundDraft, "replyToMessageId"> & { replyToMessageId?: never }
  ): Promise<{ providerMessageId?: string | null } | unknown>;
};

type DeliveryErrorDisposition = {
  retryable: boolean;
  retryAfterMs: number | null;
};

const COMPLETION_RESULT_LIMIT = 24_000;
const COMPLETION_PART_LIMIT = 4_000;

export class DesktopCompletionMonitor {
  private readonly pollIntervalMs: number;
  private readonly stabilityWindowMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => Date;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly logger: Pick<Console, "info" | "warn">;
  private readonly states = new Map<string, ThreadState>();
  private readonly startupThreadIds = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private initialized = false;
  private lastPollAt: string | null = null;
  private lastCompletionAt: string | null = null;
  private lastError: string | null = null;
  private targetConfigured = false;

  constructor(
    private readonly source: { readCompletionPoll(): Promise<DesktopCompletionPoll> },
    private readonly repository: SqliteCompletionRepository,
    private readonly egressByAccountKey: Record<string, CompletionEgress>,
    options: MonitorOptions = {}
  ) {
    this.pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 1_000);
    this.stabilityWindowMs = Math.max(0, options.stabilityWindowMs ?? 3_000);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.now = options.now ?? (() => new Date());
    this.setIntervalFn = options.setIntervalFn ?? setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
    this.logger = options.logger ?? console;
  }

  async start(): Promise<void> {
    if (this.timer) {
      return;
    }
    await this.pollOnce();
    this.timer = this.setIntervalFn(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
    while (this.pollInFlight) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  getHealth(): DesktopCompletionMonitorHealth {
    return {
      running: this.timer !== null,
      initialized: this.initialized,
      healthy: this.lastError === null,
      targetConfigured: this.targetConfigured,
      lastPollAt: this.lastPollAt,
      lastCompletionAt: this.lastCompletionAt,
      lastError: this.lastError
    };
  }

  async pollOnce(): Promise<void> {
    if (this.pollInFlight) {
      return;
    }
    this.pollInFlight = true;
    try {
      const poll = await this.source.readCompletionPoll();
      const now = this.now();
      this.lastPollAt = now.toISOString();
      this.lastError = null;
      const target = this.repository.resolveDefaultTarget(now.toISOString());
      this.targetConfigured = target !== null;

      if (!this.initialized) {
        for (const threadId of poll.topLevelThreadIds) {
          this.startupThreadIds.add(threadId);
        }
        if (poll.active?.isTopLevel) {
          this.states.set(poll.active.threadId, {
            phase: poll.active.isRunning ? "baseline-running" : "idle",
            baselineResponseId: poll.active.responseId,
            baselineResponseHash: poll.active.responseHash,
            runEpoch: null,
            candidateResponseId: null,
            candidateHash: null,
            candidateSinceMs: null
          });
        }
        this.initialized = true;
        await this.deliverDue(now);
        return;
      }

      if (poll.active?.isTopLevel) {
        await this.observe(poll.active, now, target?.sessionKey ?? null);
      }
      await this.deliverDue(now);
    } catch (error) {
      this.lastError = sanitizeDiagnostic(error);
      this.logger.warn("[qq-codex-bridge] desktop completion monitor poll failed", {
        error: this.lastError
      });
    } finally {
      this.pollInFlight = false;
    }
  }

  private async observe(
    snapshot: DesktopCompletionSnapshot,
    now: Date,
    targetSessionKey: string | null
  ): Promise<void> {
    let state = this.states.get(snapshot.threadId);
    if (!state) {
      const existedAtStartup = this.startupThreadIds.has(snapshot.threadId);
      state = {
        phase: snapshot.isRunning && existedAtStartup ? "baseline-running" : snapshot.isRunning ? "running" : "idle",
        baselineResponseId: snapshot.responseId,
        baselineResponseHash: snapshot.responseHash,
        runEpoch: snapshot.isRunning && !existedAtStartup ? now.toISOString() : null,
        candidateResponseId: null,
        candidateHash: null,
        candidateSinceMs: null
      };
      this.states.set(snapshot.threadId, state);
      return;
    }

    if (state.phase === "baseline-running") {
      if (!snapshot.isRunning) {
        resetToIdle(state, snapshot);
      }
      return;
    }

    if (state.phase === "idle") {
      if (snapshot.isRunning) {
        state.phase = "running";
        state.baselineResponseId = snapshot.responseId;
        state.baselineResponseHash = snapshot.responseHash;
        state.runEpoch = now.toISOString();
      }
      return;
    }

    if (state.phase === "running") {
      if (snapshot.isRunning) {
        return;
      }
      if (
        !snapshot.responseText?.trim()
        || (
          snapshot.responseId === state.baselineResponseId
          && snapshot.responseHash === state.baselineResponseHash
        )
      ) {
        resetToIdle(state, snapshot);
        return;
      }
      state.phase = "candidate";
      state.candidateResponseId = snapshot.responseId;
      state.candidateHash = snapshot.responseHash;
      state.candidateSinceMs = now.getTime();
      return;
    }

    if (snapshot.isRunning) {
      state.phase = "running";
      state.candidateResponseId = null;
      state.candidateHash = null;
      state.candidateSinceMs = null;
      return;
    }
    if (
      snapshot.responseId !== state.candidateResponseId
      || snapshot.responseHash !== state.candidateHash
    ) {
      state.candidateResponseId = snapshot.responseId;
      state.candidateHash = snapshot.responseHash;
      state.candidateSinceMs = now.getTime();
      return;
    }
    if (now.getTime() - (state.candidateSinceMs ?? now.getTime()) < this.stabilityWindowMs) {
      return;
    }

    const origin = this.repository.consumeTurnOrigin(
      snapshot.threadId,
      state.baselineResponseId,
      state.baselineResponseHash,
      now.toISOString()
    ) ?? "desktop";
    const completionKey = buildCompletionKey(snapshot, state.runEpoch);
    const notificationText = origin === "desktop"
      ? formatCompletionNotification(snapshot, now)
      : null;
    const notificationParts = notificationText
      ? splitCompletionNotification(notificationText)
      : undefined;
    if (!targetSessionKey && origin === "desktop") {
      this.logger.warn("[qq-codex-bridge] COMPLETION_TARGET_MISSING");
    }
    this.repository.reserveNotification({
      completionKey,
      threadId: snapshot.threadId,
      turnId: snapshot.turnId,
      responseId: snapshot.responseId,
      responseHash: snapshot.responseHash,
      origin,
      targetSessionKey,
      notificationText,
      notificationParts,
      createdAt: now.toISOString()
    });
    this.lastCompletionAt = now.toISOString();
    resetToIdle(state, snapshot);
  }

  private async deliverDue(now: Date): Promise<void> {
    for (const job of this.repository.listDue(now.toISOString())) {
      await this.deliverJob(job, now);
    }
  }

  private async deliverJob(job: CompletionNotificationRecord, now: Date): Promise<void> {
    const accountKey = extractAccountKey(job.targetSessionKey);
    const egress = accountKey ? this.egressByAccountKey[accountKey] : null;
    if (!egress) {
      this.repository.markFailed({
        completionKey: job.completionKey,
        partIndex: job.partIndex,
        attemptCount: job.attemptCount,
        maxAttempts: this.maxAttempts,
        nextAttemptAt: new Date(now.getTime() + 30_000).toISOString(),
        error: "completion egress unavailable",
        now: now.toISOString()
      });
      return;
    }
    try {
      const result = await egress.deliverProactive({
        draftId: job.partCount > 1
          ? `${job.completionKey}:part:${job.partIndex + 1}-of-${job.partCount}`
          : job.completionKey,
        turnId: job.turnId ?? undefined,
        sessionKey: job.targetSessionKey,
        text: job.notificationText,
        createdAt: now.toISOString()
      });
      const providerMessageId = result && typeof result === "object" && "providerMessageId" in result
        ? String(result.providerMessageId ?? "") || null
        : null;
      this.repository.markSent(job.completionKey, job.partIndex, providerMessageId, now.toISOString());
    } catch (error) {
      const disposition = classifyCompletionDeliveryError(error);
      const delayMs = disposition.retryAfterMs
        ?? Math.min(120_000, 5_000 * 2 ** job.attemptCount);
      this.repository.markFailed({
        completionKey: job.completionKey,
        partIndex: job.partIndex,
        attemptCount: job.attemptCount,
        maxAttempts: this.maxAttempts,
        nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
        error: sanitizeDiagnostic(error),
        now: now.toISOString(),
        permanent: !disposition.retryable
      });
      this.logger.warn("[qq-codex-bridge] completion notification delivery failed", {
        completionKeyHash: shortHash(job.completionKey),
        error: sanitizeDiagnostic(error)
      });
    }
  }
}

export function classifyCompletionDeliveryError(error: unknown): DeliveryErrorDisposition {
  const details = readErrorDetails(error);
  if (details.httpStatus === 429) {
    return { retryable: true, retryAfterMs: details.retryAfterMs };
  }
  if (details.httpStatus !== null) {
    if (details.httpStatus >= 500 && details.httpStatus <= 599) {
      return { retryable: true, retryAfterMs: null };
    }
    if (details.httpStatus >= 400 && details.httpStatus <= 499) {
      return { retryable: false, retryAfterMs: null };
    }
  }

  if (details.businessCode === "40034024") {
    return { retryable: false, retryAfterMs: null };
  }
  if (["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ENOTFOUND"].includes(details.code)) {
    return { retryable: true, retryAfterMs: null };
  }
  if (details.name === "AbortError" || /\b(?:timeout|timed out|connection reset|dns transient)\b/i.test(details.message)) {
    return { retryable: true, retryAfterMs: null };
  }
  if (/\b(?:HTTP|failed:)\s*429\b/i.test(details.message)) {
    return { retryable: true, retryAfterMs: details.retryAfterMs };
  }
  if (/\b(?:HTTP|failed:)\s*5\d\d\b/i.test(details.message)) {
    return { retryable: true, retryAfterMs: null };
  }
  if (/\b(?:HTTP|failed:)\s*4\d\d\b|40034024|invalid(?:\/unauthorized)?\s+(?:parameter|msg_id|openid)|permission denied/i.test(details.message)) {
    return { retryable: false, retryAfterMs: null };
  }

  return { retryable: false, retryAfterMs: null };
}

function readErrorDetails(error: unknown): {
  httpStatus: number | null;
  businessCode: string;
  retryAfterMs: number | null;
  code: string;
  name: string;
  message: string;
} {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
  const message = error instanceof Error ? error.message : String(error ?? "");
  const statusCandidate = record?.httpStatus ?? record?.status;
  const retryAfterCandidate = record?.retryAfterMs;
  const codeCandidate = record?.businessCode ?? record?.errCode ?? record?.errorCode;
  return {
    httpStatus: typeof statusCandidate === "number" && Number.isFinite(statusCandidate)
      ? statusCandidate
      : null,
    businessCode: codeCandidate === undefined || codeCandidate === null ? "" : String(codeCandidate),
    retryAfterMs: typeof retryAfterCandidate === "number" && Number.isFinite(retryAfterCandidate)
      ? Math.max(0, retryAfterCandidate)
      : null,
    code: record?.code === undefined || record?.code === null ? "" : String(record.code),
    name: error instanceof Error ? error.name : "",
    message
  };
}

function resetToIdle(state: ThreadState, snapshot: DesktopCompletionSnapshot): void {
  state.phase = "idle";
  state.baselineResponseId = snapshot.responseId;
  state.baselineResponseHash = snapshot.responseHash;
  state.runEpoch = null;
  state.candidateResponseId = null;
  state.candidateHash = null;
  state.candidateSinceMs = null;
}

function buildCompletionKey(snapshot: DesktopCompletionSnapshot, runEpoch: string | null): string {
  if (snapshot.responseId) {
    return `desktop-completion:${snapshot.threadId}:${snapshot.responseId}`;
  }
  return `desktop-completion:${snapshot.threadId}:${snapshot.responseHash}:${runEpoch ?? "observed"}`;
}

export function formatCompletionNotification(snapshot: DesktopCompletionSnapshot, now: Date): string {
  const title = sanitizeTitle(snapshot.title) || "未命名会话";
  const project = snapshot.projectName ? path.basename(snapshot.projectName) : null;
  const result = summarizeCompletionResult(snapshot.responseText ?? "");
  return [
    "✅ Codex 任务完成",
    "",
    ...(project ? [`项目：${project}`] : []),
    `会话：${title}`,
    `时间：${formatLocalTime(now)}`,
    "状态：完成",
    "",
    "结果：",
    result
  ].join("\n");
}

export function summarizeCompletionResult(value: string, limit = COMPLETION_RESULT_LIMIT): string {
  const effectiveLimit = Math.max(1, limit);
  const redacted = redactSecrets(value)
    .replace(/\r\n?/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  const normalized = redacted || "任务已完成。";
  if (normalized.length <= effectiveLimit) {
    return normalized;
  }
  const notice = `\n\n⚠️ 结果过长，已达到 ${effectiveLimit} 字符总上限，其余内容已省略。`;
  return `${sliceUtf16Safely(normalized, Math.max(0, effectiveLimit - notice.length))}${notice}`;
}

export function splitCompletionNotification(
  text: string,
  maxPartLength = COMPLETION_PART_LIMIT
): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const safeLimit = Math.max(256, maxPartLength);
  if (normalized.length <= safeLimit) {
    return [normalized];
  }

  const rawParts = splitAtReadableBoundaries(normalized, safeLimit - 96);
  let openFence: string | null = null;
  const markdownSafeParts = rawParts.map((rawPart, index) => {
    const startsInsideFence = openFence !== null;
    const reopened = startsInsideFence ? `${openFence}\n` : "";
    openFence = scanOpenFence(rawPart, openFence);
    const closed = openFence !== null && index < rawParts.length - 1 ? "\n```" : "";
    return `${reopened}${rawPart}${closed}`;
  });
  const total = markdownSafeParts.length;
  return markdownSafeParts.map((part, index) => (
    `【Codex 完成通知 ${index + 1}/${total}】\n${part}`
  ));
}

function splitAtReadableBoundaries(text: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const minimum = Math.floor(limit * 0.55);
    const window = rest.slice(0, limit + 1);
    const candidates = [
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(" ")
    ].filter((candidate) => candidate >= minimum);
    const cut = candidates.length > 0 ? Math.max(...candidates) + 1 : limit;
    const safeCut = safeUtf16End(rest, cut);
    parts.push(rest.slice(0, safeCut));
    rest = rest.slice(safeCut);
  }
  if (rest) {
    parts.push(rest);
  }
  return parts;
}

function scanOpenFence(text: string, initialFence: string | null): string | null {
  let openFence = initialFence;
  for (const match of text.matchAll(/^\s{0,3}(```[^\n]*)/gm)) {
    openFence = openFence === null ? sliceUtf16Safely(match[1].trim(), 48) : null;
  }
  return openFence;
}

function sliceUtf16Safely(value: string, end: number): string {
  return value.slice(0, safeUtf16End(value, end));
}

function safeUtf16End(value: string, end: number): number {
  let safeEnd = Math.min(Math.max(0, end), value.length);
  if (safeEnd > 0 && safeEnd < value.length) {
    const previous = value.charCodeAt(safeEnd - 1);
    const next = value.charCodeAt(safeEnd);
    if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
      safeEnd -= 1;
    }
  }
  return safeEnd;
}

export function redactSecrets(value: string): string {
  return value
    .replace(/\b(QQBOT_APPSECRET|QQBOT_CLIENT_SECRET|ACCESS_TOKEN|AUTHORIZATION)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|API_KEY)\b\s*[:=]\s*[^\s,;]+/g, "[REDACTED_SECRET]");
}

function sanitizeTitle(value: string | null): string {
  return redactSecrets(value ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 120);
}

function formatLocalTime(now: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(now);
}

function sanitizeDiagnostic(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function extractAccountKey(sessionKey: string): string | null {
  const separator = sessionKey.indexOf("::");
  return separator > 0 ? sessionKey.slice(0, separator) : null;
}

function shortHash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

