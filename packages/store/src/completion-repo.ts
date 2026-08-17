import type { SqliteDatabase } from "./sqlite.js";

export type CompletionTarget = {
  sessionKey: string;
  accountKey: string;
};

export type CompletionNotificationRecord = {
  completionKey: string;
  threadId: string;
  turnId: string | null;
  responseId: string | null;
  responseHash: string;
  targetSessionKey: string;
  notificationText: string;
  attemptCount: number;
  partIndex: number;
  partCount: number;
};

export class SqliteCompletionRepository {
  constructor(private readonly db: SqliteDatabase) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS desktop_completion_config (
        config_id INTEGER PRIMARY KEY CHECK (config_id = 1),
        target_session_key TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS desktop_completion_notifications (
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

      CREATE INDEX IF NOT EXISTS desktop_completion_notifications_due
        ON desktop_completion_notifications(status, next_attempt_at);

      CREATE TABLE IF NOT EXISTS desktop_completion_notification_parts (
        completion_key TEXT NOT NULL,
        part_index INTEGER NOT NULL,
        part_count INTEGER NOT NULL,
        part_text TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        provider_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        PRIMARY KEY (completion_key, part_index),
        FOREIGN KEY (completion_key) REFERENCES desktop_completion_notifications(completion_key)
      );

      CREATE INDEX IF NOT EXISTS desktop_completion_notification_parts_due
        ON desktop_completion_notification_parts(status, next_attempt_at);

      CREATE TABLE IF NOT EXISTS desktop_turn_origins (
        correlation_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        baseline_response_id TEXT,
        baseline_response_hash TEXT NOT NULL,
        origin TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS desktop_turn_origins_pending
        ON desktop_turn_origins(thread_id, consumed_at, expires_at);

      INSERT OR IGNORE INTO desktop_completion_notification_parts (
        completion_key, part_index, part_count, part_text, status, attempt_count,
        next_attempt_at, last_error, provider_message_id, created_at, updated_at, sent_at
      )
      SELECT completion_key, 0, 1, notification_text, status, attempt_count,
             next_attempt_at, last_error, NULL, created_at, updated_at, sent_at
      FROM desktop_completion_notifications
      WHERE origin = 'desktop' AND notification_text IS NOT NULL;
    `);
  }

  resolveDefaultTarget(now = new Date().toISOString()): CompletionTarget | null {
    const configured = this.db.prepare(
      `SELECT c.target_session_key AS sessionKey, s.account_key AS accountKey
       FROM desktop_completion_config c
       JOIN bridge_sessions s ON s.session_key = c.target_session_key
       WHERE c.config_id = 1 AND s.chat_type = 'c2c'`
    ).get() as CompletionTarget | undefined;
    if (configured) {
      return configured;
    }

    const captured = this.db.prepare(
      `SELECT session_key AS sessionKey, account_key AS accountKey
       FROM bridge_sessions
       WHERE chat_type = 'c2c'
       ORDER BY COALESCE(last_inbound_at, '') DESC, rowid DESC
       LIMIT 1`
    ).get() as CompletionTarget | undefined;
    if (!captured) {
      return null;
    }

    this.db.prepare(
      `INSERT INTO desktop_completion_config (config_id, target_session_key, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(config_id) DO UPDATE SET
         target_session_key = excluded.target_session_key,
         updated_at = excluded.updated_at`
    ).run(captured.sessionKey, now);
    return captured;
  }

  recordTurnOrigin(input: {
    correlationId: string;
    threadId: string;
    baselineResponseId: string | null;
    baselineResponseHash: string;
    origin: "qq";
    createdAt: string;
    expiresAt: string;
  }): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO desktop_turn_origins (
        correlation_id, thread_id, baseline_response_id, baseline_response_hash,
        origin, created_at, expires_at, consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
    ).run(
      input.correlationId,
      input.threadId,
      input.baselineResponseId,
      input.baselineResponseHash,
      input.origin,
      input.createdAt,
      input.expiresAt
    );
  }

  consumeTurnOrigin(
    threadId: string,
    baselineResponseId: string | null,
    baselineResponseHash: string,
    now: string
  ): "qq" | null {
    const row = this.db.prepare(
      `SELECT correlation_id AS correlationId, origin
       FROM desktop_turn_origins
       WHERE thread_id = ?
         AND consumed_at IS NULL
         AND expires_at > ?
         AND COALESCE(baseline_response_id, '') = COALESCE(?, '')
         AND baseline_response_hash = ?
       ORDER BY created_at ASC
       LIMIT 1`
    ).get(threadId, now, baselineResponseId, baselineResponseHash) as {
      correlationId: string;
      origin: "qq";
    } | undefined;
    if (!row) {
      return null;
    }
    this.db.prepare(
      `UPDATE desktop_turn_origins SET consumed_at = ? WHERE correlation_id = ?`
    ).run(now, row.correlationId);
    return row.origin;
  }

  reserveNotification(input: {
    completionKey: string;
    threadId: string;
    turnId: string | null;
    responseId: string | null;
    responseHash: string;
    origin: "desktop" | "qq";
    targetSessionKey: string | null;
    notificationText: string | null;
    notificationParts?: string[];
    createdAt: string;
  }): boolean {
    const status = input.origin === "qq" ? "suppressed" : "pending";
    const requestedParts = input.notificationParts?.filter((part) => part.length > 0) ?? [];
    const parts = input.origin === "desktop"
      ? (requestedParts.length > 0
        ? requestedParts
        : [input.notificationText || "任务已完成。"])
      : [];
    const insertNotification = this.db.prepare(
      `INSERT OR IGNORE INTO desktop_completion_notifications (
        completion_key, thread_id, turn_id, response_id, response_hash, origin,
        status, target_session_key, notification_text, attempt_count,
        next_attempt_at, last_error, created_at, updated_at, sent_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, NULL)`
    );
    const insertPart = this.db.prepare(
      `INSERT INTO desktop_completion_notification_parts (
        completion_key, part_index, part_count, part_text, status, attempt_count,
        next_attempt_at, last_error, provider_message_id, created_at, updated_at, sent_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, ?, NULL)`
    );
    const reserve = this.db.transaction(() => {
      const result = insertNotification.run(
        input.completionKey,
        input.threadId,
        input.turnId,
        input.responseId,
        input.responseHash,
        input.origin,
        status,
        input.targetSessionKey,
        input.notificationText,
        input.origin === "desktop" ? input.createdAt : null,
        input.createdAt,
        input.createdAt
      );
      if (result.changes === 0) {
        return false;
      }
      for (const [index, part] of parts.entries()) {
        insertPart.run(
          input.completionKey,
          index,
          parts.length,
          part,
          input.createdAt,
          input.createdAt,
          input.createdAt
        );
      }
      return true;
    });
    return reserve();
  }

  listDue(now: string, limit = 10): CompletionNotificationRecord[] {
    return this.db.prepare(
      `SELECT n.completion_key AS completionKey, n.thread_id AS threadId,
              n.turn_id AS turnId, n.response_id AS responseId,
              n.response_hash AS responseHash, n.target_session_key AS targetSessionKey,
              p.part_text AS notificationText, p.attempt_count AS attemptCount,
              p.part_index AS partIndex, p.part_count AS partCount
       FROM desktop_completion_notification_parts p
       JOIN desktop_completion_notifications n ON n.completion_key = p.completion_key
       WHERE p.status IN ('pending', 'retry_wait')
         AND p.next_attempt_at <= ?
         AND n.target_session_key IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM desktop_completion_notification_parts earlier
           WHERE earlier.completion_key = p.completion_key
             AND earlier.part_index < p.part_index
             AND earlier.status <> 'sent'
         )
       ORDER BY n.created_at ASC, p.part_index ASC
       LIMIT ?`
    ).all(now, limit) as CompletionNotificationRecord[];
  }

  markSent(completionKey: string, partIndex: number, providerMessageId: string | null, now: string): void {
    const completePart = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE desktop_completion_notification_parts
         SET status = 'sent', attempt_count = attempt_count + 1,
             last_error = NULL, provider_message_id = ?, sent_at = ?, updated_at = ?
         WHERE completion_key = ? AND part_index = ? AND status <> 'sent'`
      ).run(providerMessageId, now, now, completionKey, partIndex);
      const remaining = this.db.prepare(
        `SELECT COUNT(*) AS count
         FROM desktop_completion_notification_parts
         WHERE completion_key = ? AND status <> 'sent'`
      ).get(completionKey) as { count: number };
      if (remaining.count === 0) {
        this.db.prepare(
          `UPDATE desktop_completion_notifications
           SET status = 'sent', attempt_count = attempt_count + 1,
               next_attempt_at = NULL, last_error = NULL, sent_at = ?, updated_at = ?
           WHERE completion_key = ?`
        ).run(now, now, completionKey);
      } else {
        this.db.prepare(
          `UPDATE desktop_completion_notifications
           SET status = 'pending', next_attempt_at = ?, last_error = NULL, updated_at = ?
           WHERE completion_key = ?`
        ).run(now, now, completionKey);
      }
    });
    completePart();
  }

  markFailed(input: {
    completionKey: string;
    partIndex: number;
    attemptCount: number;
    maxAttempts: number;
    nextAttemptAt: string;
    error: string;
    now: string;
    permanent?: boolean;
  }): void {
    const status = input.permanent || input.attemptCount + 1 >= input.maxAttempts
      ? "dead"
      : "retry_wait";
    const failPart = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE desktop_completion_notification_parts
         SET status = ?, attempt_count = attempt_count + 1,
             next_attempt_at = ?, last_error = ?, updated_at = ?
         WHERE completion_key = ? AND part_index = ? AND status <> 'sent'`
      ).run(
        status,
        input.nextAttemptAt,
        input.error.slice(0, 500),
        input.now,
        input.completionKey,
        input.partIndex
      );
      this.db.prepare(
        `UPDATE desktop_completion_notifications
         SET status = ?, attempt_count = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
         WHERE completion_key = ?`
      ).run(
        status,
        input.attemptCount + 1,
        input.nextAttemptAt,
        input.error.slice(0, 500),
        input.now,
        input.completionKey
      );
    });
    failPart();
  }

  getStatus(completionKey: string): string | null {
    const row = this.db.prepare(
      `SELECT status FROM desktop_completion_notifications WHERE completion_key = ?`
    ).get(completionKey) as { status: string } | undefined;
    return row?.status ?? null;
  }
}

