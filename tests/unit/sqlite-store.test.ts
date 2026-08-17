import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import { BridgeSessionStatus } from "../../packages/domain/src/session.js";
import { buildPeerKey, buildSessionKey } from "../../packages/orchestrator/src/session-key.js";
import { createSqliteDatabase } from "../../packages/store/src/sqlite.js";
import type { SqliteDatabase } from "../../packages/store/src/sqlite.js";
import { SqliteSessionStore } from "../../packages/store/src/session-repo.js";
import { SqliteTranscriptStore } from "../../packages/store/src/message-repo.js";
import { SqliteCompletionRepository } from "../../packages/store/src/completion-repo.js";

describe("sqlite store", () => {
  const tempDirs: string[] = [];
  const databases: SqliteDatabase[] = [];

  afterEach(() => {
    while (databases.length > 0) {
      databases.pop()?.close();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createTempDbPath(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "qq-codex-bridge-"));
    tempDirs.push(dir);
    return path.join(dir, "data", "bridge.sqlite");
  }

  function createTempDatabase(): SqliteDatabase {
    const db = createSqliteDatabase(createTempDbPath());
    databases.push(db);
    return db;
  }

  function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;

    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    return { promise, resolve, reject };
  }

  it("persists a session that can be read back as active", async () => {
    const db = createTempDatabase();
    const sessionStore = new SqliteSessionStore(db);

    const sessionKey = buildSessionKey({
      accountKey: "qqbot:default",
      peerKey: buildPeerKey({ chatType: "c2c", peerId: "abc-123" })
    });

    await sessionStore.createSession({
      sessionKey,
      accountKey: "qqbot:default",
      peerKey: "qq:c2c:abc-123",
      chatType: "c2c",
      peerId: "abc-123",
      codexThreadRef: null,
      lastCodexTurnId: null,
      skillContextKey: null,
      conversationProvider: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: null
    });

    const session = await sessionStore.getSession(sessionKey);

    expect(session).toEqual({
      sessionKey,
      accountKey: "qqbot:default",
      peerKey: "qq:c2c:abc-123",
      chatType: "c2c",
      peerId: "abc-123",
      codexThreadRef: null,
      lastCodexTurnId: null,
      skillContextKey: null,
      conversationProvider: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: null
    });
  });

  it("persists and updates the latest codex turn id on the session", async () => {
    const db = createTempDatabase();
    const sessionStore = new SqliteSessionStore(db);

    const sessionKey = buildSessionKey({
      accountKey: "qqbot:default",
      peerKey: buildPeerKey({ chatType: "c2c", peerId: "abc-456" })
    });

    await sessionStore.createSession({
      sessionKey,
      accountKey: "qqbot:default",
      peerKey: "qq:c2c:abc-456",
      chatType: "c2c",
      peerId: "abc-456",
      codexThreadRef: "codex-thread:page-1:thread-a",
      lastCodexTurnId: null,
      skillContextKey: null,
      conversationProvider: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: null
    });

    await sessionStore.updateLastCodexTurnId(sessionKey, "turn-local-123");

    await expect(sessionStore.getSession(sessionKey)).resolves.toMatchObject({
      sessionKey,
      lastCodexTurnId: "turn-local-123"
    });
  });

  it("records inbound messages and prevents duplicate digests", async () => {
    const db = createTempDatabase();
    const transcriptStore = new SqliteTranscriptStore(db);

    await transcriptStore.recordInbound({
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:abc-123",
      peerKey: "qq:c2c:abc-123",
      chatType: "c2c",
      senderId: "abc-123",
      text: "hello",
      receivedAt: "2026-04-08T10:00:00.000Z"
    });

    await transcriptStore.recordInbound({
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:abc-123",
      peerKey: "qq:c2c:abc-123",
      chatType: "c2c",
      senderId: "abc-123",
      text: "hello",
      receivedAt: "2026-04-08T10:00:00.000Z"
    });

    await transcriptStore.recordOutbound({
      draftId: "draft-1",
      sessionKey: "qqbot:default::qq:c2c:abc-123",
      text: "reply",
      createdAt: "2026-04-08T10:00:01.000Z"
    });

    await expect(transcriptStore.hasInbound("msg-1")).resolves.toBe(true);
    await expect(transcriptStore.hasInbound("msg-2")).resolves.toBe(false);
  });

  it("serializes overlapping work for the same session key", async () => {
    const db = createTempDatabase();
    const sessionStore = new SqliteSessionStore(db);
    const sessionKey = buildSessionKey({
      accountKey: "qqbot:default",
      peerKey: buildPeerKey({ chatType: "c2c", peerId: "abc-123" })
    });

    const firstTurn = createDeferred<void>();
    const secondEntered: string[] = [];
    const firstEntered = createDeferred<void>();

    const firstWork = sessionStore.withSessionLock(sessionKey, async () => {
      firstEntered.resolve();
      await firstTurn.promise;
    });

    await firstEntered.promise;

    const secondWork = sessionStore.withSessionLock(sessionKey, async () => {
      secondEntered.push("entered");
    });

    expect(secondEntered).toEqual([]);

    firstTurn.resolve();

    await expect(firstWork).resolves.toBeUndefined();
    await expect(secondWork).resolves.toBeUndefined();
    expect(secondEntered).toEqual(["entered"]);
  });

  it("replaces a stale in-db lock left behind by a previous process", async () => {
    const db = createTempDatabase();
    const sessionStore = new SqliteSessionStore(db);
    const sessionKey = buildSessionKey({
      accountKey: "qqbot:default",
      peerKey: buildPeerKey({ chatType: "c2c", peerId: "abc-123" })
    });

    db.prepare(
      `INSERT INTO session_locks (session_key, owner, locked_at, expires_at)
       VALUES (?, ?, ?, ?)`
    ).run(
      sessionKey,
      "dead-process-owner",
      "2026-04-09T10:00:00.000Z",
      "2099-04-09T10:01:00.000Z"
    );

    const calls: string[] = [];

    await expect(
      sessionStore.withSessionLock(sessionKey, async () => {
        calls.push("entered");
      })
    ).resolves.toBeUndefined();

    expect(calls).toEqual(["entered"]);
    const remainingLocks = db
      .prepare(`SELECT COUNT(*) AS count FROM session_locks WHERE session_key = ?`)
      .get(sessionKey) as { count: number };
    expect(remainingLocks.count).toBe(0);
  });

  it("persists the completion target, origin correlation, and exactly-once ledger across restart", async () => {
    const db = createTempDatabase();
    const sessionStore = new SqliteSessionStore(db);
    await sessionStore.createSession({
      sessionKey: "qqbot:default::qq:c2c:captured-target",
      accountKey: "qqbot:default",
      peerKey: "qq:c2c:captured-target",
      chatType: "c2c",
      peerId: "captured-target",
      codexThreadRef: null,
      lastCodexTurnId: null,
      skillContextKey: null,
      conversationProvider: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: "2026-08-16T03:00:00.000Z",
      lastOutboundAt: null,
      lastError: null
    });

    const first = new SqliteCompletionRepository(db);
    expect(first.resolveDefaultTarget()).toEqual({
      sessionKey: "qqbot:default::qq:c2c:captured-target",
      accountKey: "qqbot:default"
    });
    first.recordTurnOrigin({
      correlationId: "qq-message-1",
      threadId: "thread-1",
      baselineResponseId: "turn-0:msg-old",
      baselineResponseHash: "old-hash",
      origin: "qq",
      createdAt: "2026-08-16T03:00:00.000Z",
      expiresAt: "2026-08-16T05:00:00.000Z"
    });
    expect(first.consumeTurnOrigin(
      "thread-1",
      "turn-0:msg-old",
      "old-hash",
      "2026-08-16T03:01:00.000Z"
    )).toBe("qq");
    expect(first.reserveNotification({
      completionKey: "desktop-completion:thread-1:turn-1:msg-final",
      threadId: "thread-1",
      turnId: "turn-1",
      responseId: "turn-1:msg-final",
      responseHash: "final-hash",
      origin: "desktop",
      targetSessionKey: "qqbot:default::qq:c2c:captured-target",
      notificationText: "safe summary",
      notificationParts: ["safe summary"],
      createdAt: "2026-08-16T03:02:00.000Z"
    })).toBe(true);
    first.markSent(
      "desktop-completion:thread-1:turn-1:msg-final",
      0,
      "provider-id",
      "2026-08-16T03:02:01.000Z"
    );

    const restarted = new SqliteCompletionRepository(db);
    expect(restarted.reserveNotification({
      completionKey: "desktop-completion:thread-1:turn-1:msg-final",
      threadId: "thread-1",
      turnId: "turn-1",
      responseId: "turn-1:msg-final",
      responseHash: "final-hash",
      origin: "desktop",
      targetSessionKey: "qqbot:default::qq:c2c:captured-target",
      notificationText: "safe summary",
      notificationParts: ["safe summary"],
      createdAt: "2026-08-16T03:03:00.000Z"
    })).toBe(false);
    expect(restarted.getStatus("desktop-completion:thread-1:turn-1:msg-final")).toBe("sent");
    expect(restarted.listDue("2026-08-16T04:00:00.000Z")).toEqual([]);
  });

  it("keeps permanent and historical dead completion jobs dead without requeueing them", async () => {
    const db = createTempDatabase();
    const repo = new SqliteCompletionRepository(db);
    const createdAt = "2026-08-16T03:00:00.000Z";
    repo.reserveNotification({
      completionKey: "desktop-completion:permanent",
      threadId: "thread-permanent",
      turnId: "turn-permanent",
      responseId: "turn-permanent:msg-final",
      responseHash: "hash-permanent",
      origin: "desktop",
      targetSessionKey: "qqbot:default::qq:c2c:captured-target",
      notificationText: "safe summary",
      notificationParts: ["safe summary"],
      createdAt
    });
    repo.markFailed({
      completionKey: "desktop-completion:permanent",
      partIndex: 0,
      attemptCount: 0,
      maxAttempts: 3,
      nextAttemptAt: "2026-08-16T03:00:05.000Z",
      error: "QQ 40034024",
      now: "2026-08-16T03:00:01.000Z",
      permanent: true
    });

    expect(repo.getStatus("desktop-completion:permanent")).toBe("dead");
    expect(repo.listDue("2026-08-17T03:00:00.000Z")).toEqual([]);

    const restarted = new SqliteCompletionRepository(db);
    expect(restarted.getStatus("desktop-completion:permanent")).toBe("dead");
    expect(restarted.listDue("2026-08-17T03:00:00.000Z")).toEqual([]);
  });

  it("persists per-part completion progress and never requeues a sent part", () => {
    const db = createTempDatabase();
    const repo = new SqliteCompletionRepository(db);
    const completionKey = "desktop-completion:multipart";
    repo.reserveNotification({
      completionKey,
      threadId: "thread-main",
      turnId: "turn-main",
      responseId: "turn-main:msg-final",
      responseHash: "hash-main",
      origin: "desktop",
      targetSessionKey: "qqbot:default::qq:c2c:captured-target",
      notificationText: "part 1\npart 2\npart 3",
      notificationParts: ["1/3 part 1", "2/3 part 2", "3/3 part 3"],
      createdAt: "2026-08-16T03:00:00.000Z"
    });

    expect(repo.listDue("2026-08-16T03:00:00.000Z")).toEqual([
      expect.objectContaining({ partIndex: 0, partCount: 3, notificationText: "1/3 part 1" })
    ]);
    repo.markSent(completionKey, 0, "provider-1", "2026-08-16T03:00:01.000Z");

    const restarted = new SqliteCompletionRepository(db);
    expect(restarted.listDue("2026-08-16T03:00:01.000Z")).toEqual([
      expect.objectContaining({ partIndex: 1, partCount: 3, notificationText: "2/3 part 2" })
    ]);
    restarted.markFailed({
      completionKey,
      partIndex: 1,
      attemptCount: 0,
      maxAttempts: 3,
      nextAttemptAt: "2026-08-16T03:00:10.000Z",
      error: "temporary",
      now: "2026-08-16T03:00:02.000Z"
    });
    expect(restarted.listDue("2026-08-16T03:00:09.000Z")).toEqual([]);
    expect(restarted.listDue("2026-08-16T03:00:10.000Z")).toEqual([
      expect.objectContaining({ partIndex: 1, attemptCount: 1 })
    ]);

    restarted.markSent(completionKey, 1, "provider-2", "2026-08-16T03:00:11.000Z");
    expect(restarted.listDue("2026-08-16T03:00:11.000Z")).toEqual([
      expect.objectContaining({ partIndex: 2, notificationText: "3/3 part 3" })
    ]);
    restarted.markSent(completionKey, 2, "provider-3", "2026-08-16T03:00:12.000Z");
    expect(restarted.getStatus(completionKey)).toBe("sent");
    expect(restarted.listDue("2026-08-17T03:00:00.000Z")).toEqual([]);
  });

  it("backfills a legacy pending completion as one resumable part", () => {
    const db = createTempDatabase();
    db.exec(`
      CREATE TABLE desktop_completion_notifications (
        completion_key TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        response_id TEXT,
        response_hash TEXT NOT NULL,
        origin TEXT NOT NULL,
        status TEXT NOT NULL,
        target_session_key TEXT,
        notification_text TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT
      );
    `);
    db.prepare(
      `INSERT INTO desktop_completion_notifications (
        completion_key, thread_id, turn_id, response_id, response_hash, origin,
        status, target_session_key, notification_text, attempt_count,
        next_attempt_at, last_error, created_at, updated_at, sent_at
      ) VALUES (?, ?, ?, ?, ?, 'desktop', 'pending', ?, ?, 0, ?, NULL, ?, ?, NULL)`
    ).run(
      "desktop-completion:legacy",
      "thread-legacy",
      "turn-legacy",
      "turn-legacy:msg-final",
      "hash-legacy",
      "qqbot:default::qq:c2c:captured-target",
      "legacy completion text",
      "2026-08-16T03:00:00.000Z",
      "2026-08-16T03:00:00.000Z",
      "2026-08-16T03:00:00.000Z"
    );

    const repo = new SqliteCompletionRepository(db);
    expect(repo.listDue("2026-08-16T03:00:00.000Z")).toEqual([
      expect.objectContaining({
        completionKey: "desktop-completion:legacy",
        partIndex: 0,
        partCount: 1,
        notificationText: "legacy completion text"
      })
    ]);
  });
});
