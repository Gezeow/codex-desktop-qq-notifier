import { existsSync, readFileSync, statSync } from "node:fs";
import { MediaArtifactKind, type MediaArtifact } from "../../../domain/src/message.js";

type FetchLike = typeof fetch;

export type QqApiClientOptions = {
  authBaseUrl?: string;
  apiBaseUrl?: string;
  fetchFn?: FetchLike;
  now?: () => number;
  markdownSupport?: boolean;
};

export type SendMessageOptions = {
  preferMarkdown?: boolean;
};

export type C2CTextReplyRequest = SendMessageOptions & {
  openid: string;
  inboundMsgId: string;
  content: string;
};

export type C2CTextProactiveRequest = SendMessageOptions & {
  openid: string;
  content: string;
};

export type C2CTextRequest =
  | ({ mode: "reply" } & C2CTextReplyRequest)
  | ({ mode: "proactive" } & C2CTextProactiveRequest);

export type QqApiErrorOptions = {
  httpStatus: number;
  businessCode?: string | number;
  retryAfterMs?: number;
};

/**
 * A QQ HTTP response that was rejected by the API.
 *
 * The error intentionally contains only protocol metadata.  QQ response
 * bodies can echo request values, so they are not copied into `message` or
 * exposed as an error property.
 */
export class QqApiError extends Error {
  readonly httpStatus: number;
  readonly businessCode?: string | number;
  readonly retryAfterMs?: number;

  constructor(message: string, options: QqApiErrorOptions) {
    super(message);
    this.name = "QqApiError";
    this.httpStatus = options.httpStatus;
    this.businessCode = options.businessCode;
    this.retryAfterMs = options.retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type CachedToken = {
  value: string;
  expiresAt: number;
};

export class QqApiClient {
  private readonly authBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly markdownSupport: boolean;
  private cachedToken: CachedToken | null = null;
  private readonly msgSeqByReplyId = new Map<string, number>();

  constructor(
    readonly appId: string,
    readonly clientSecret: string,
    options: QqApiClientOptions = {}
  ) {
    this.authBaseUrl = options.authBaseUrl ?? "https://bots.qq.com";
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.sgroup.qq.com";
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.markdownSupport = options.markdownSupport ?? false;
  }

  async getAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > this.now()) {
      return this.cachedToken.value;
    }

    const response = await this.fetchFn(`${this.authBaseUrl}/app/getAppAccessToken`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        appId: this.appId,
        clientSecret: this.clientSecret
      })
    });

    if (!response.ok) {
      throw await this.toApiError(response, "auth");
    }

    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number | string;
    };

    const expiresIn =
      typeof payload.expires_in === "number"
        ? payload.expires_in
        : typeof payload.expires_in === "string"
          ? Number(payload.expires_in)
          : Number.NaN;

    if (!payload.access_token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error("QQ auth response missing access token");
    }

    this.cachedToken = {
      value: payload.access_token,
      expiresAt: this.now() + Math.max(expiresIn - 60, 1) * 1000
    };

    return payload.access_token;
  }

  invalidateAccessToken(): void {
    this.cachedToken = null;
  }

  async getGatewayUrl(): Promise<string> {
    const accessToken = await this.getAccessToken();
    const response = await this.fetchFn(`${this.apiBaseUrl}/gateway`, {
      method: "GET",
      headers: {
        authorization: `QQBot ${accessToken}`,
        "content-type": "application/json"
      }
    });

    if (!response.ok) {
      throw await this.toApiError(response, "gateway discovery");
    }

    const payload = (await response.json()) as { url?: string };
    if (!payload.url) {
      throw new Error("QQ gateway response missing websocket url");
    }

    return payload.url;
  }

  async sendC2CReply(request: C2CTextReplyRequest): Promise<string | null> {
    assertNonEmpty(request.openid, "openid");
    assertNonEmpty(request.inboundMsgId, "inboundMsgId");

    return this.sendMessage(`/v2/users/${encodeURIComponent(request.openid)}/messages`, {
      mode: "reply",
      content: request.content,
      inboundMsgId: request.inboundMsgId,
      preferMarkdown: request.preferMarkdown,
      sequenceKey: request.inboundMsgId
    });
  }

  async sendC2CProactive(request: C2CTextProactiveRequest): Promise<string | null> {
    assertNonEmpty(request.openid, "openid");

    return this.sendMessage(`/v2/users/${encodeURIComponent(request.openid)}/messages`, {
      mode: "proactive",
      content: request.content,
      preferMarkdown: request.preferMarkdown,
      sequenceKey: `proactive:${request.openid}`
    });
  }

  /**
   * Backwards-compatible strict reply alias.  It deliberately requires a
   * message id and never infers a proactive send from an omitted argument.
   */
  async sendC2CMessage(
    userOpenId: string,
    content: string,
    inboundMsgId: string,
    options: SendMessageOptions = {}
  ): Promise<string | null> {
    return this.sendC2CReply({
      openid: userOpenId,
      content,
      inboundMsgId,
      ...options
    });
  }

  async sendGroupMessage(
    groupOpenId: string,
    content: string,
    msgId: string,
    options: SendMessageOptions = {}
  ): Promise<string | null> {
    assertNonEmpty(groupOpenId, "groupOpenId");
    assertNonEmpty(msgId, "msgId");

    return this.sendMessage(`/v2/groups/${encodeURIComponent(groupOpenId)}/messages`, {
      mode: "reply",
      content,
      inboundMsgId: msgId,
      preferMarkdown: options.preferMarkdown,
      sequenceKey: msgId
    });
  }

  async sendC2CMediaArtifact(
    userOpenId: string,
    artifact: MediaArtifact,
    msgId: string,
    content?: string
  ): Promise<string | null> {
    return this.sendMediaArtifact(`/v2/users/${encodeURIComponent(userOpenId)}`, artifact, msgId, content);
  }

  async sendGroupMediaArtifact(
    groupOpenId: string,
    artifact: MediaArtifact,
    msgId: string,
    content?: string
  ): Promise<string | null> {
    return this.sendMediaArtifact(`/v2/groups/${encodeURIComponent(groupOpenId)}`, artifact, msgId, content);
  }

  private async sendMessage(
    path: string,
    request: MessageRequest
  ): Promise<string | null> {
    const accessToken = await this.getAccessToken();
    const response = await this.fetchFn(`${this.apiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `QQBot ${accessToken}`,
        "content-type": "application/json",
        "X-Union-Appid": this.appId
      },
      body: JSON.stringify(this.buildMessageBody(request))
    });

    if (!response.ok) {
      throw await this.toApiError(response, "message send");
    }

    const payload = (await response.json()) as { id?: string };
    return payload.id ?? null;
  }

  private async sendMediaArtifact(
    pathPrefix: string,
    artifact: MediaArtifact,
    msgId: string,
    content?: string
  ): Promise<string | null> {
    this.assertSupportedMediaFormat(artifact);
    const accessToken = await this.getAccessToken();
    const uploadBody = await this.buildMediaUploadBody(artifact);
    const uploadResponse = await this.fetchFn(`${this.apiBaseUrl}${pathPrefix}/files`, {
      method: "POST",
      headers: {
        authorization: `QQBot ${accessToken}`,
        "content-type": "application/json",
        "X-Union-Appid": this.appId
      },
      body: JSON.stringify({
        ...uploadBody,
        file_type: this.mapMediaFileType(artifact.kind),
        srv_send_msg: false,
        ...(artifact.kind === MediaArtifactKind.File ? { file_name: artifact.originalName } : {})
      })
    });

    if (!uploadResponse.ok) {
      throw await this.toApiError(uploadResponse, "media upload");
    }

    const uploadPayload = (await uploadResponse.json()) as { file_info?: string };
    if (!uploadPayload.file_info) {
      throw new Error("QQ media upload response missing file_info");
    }

    const response = await this.fetchFn(`${this.apiBaseUrl}${pathPrefix}/messages`, {
      method: "POST",
      headers: {
        authorization: `QQBot ${accessToken}`,
        "content-type": "application/json",
        "X-Union-Appid": this.appId
      },
      body: JSON.stringify({
        msg_type: 7,
        media: { file_info: uploadPayload.file_info },
        msg_seq: this.nextMsgSeq(msgId),
        msg_id: msgId,
        ...(content ? { content } : {})
      })
    });

    if (!response.ok) {
      throw await this.toApiError(response, "media message send");
    }

    const payload = (await response.json()) as { id?: string };
    return payload.id ?? null;
  }

  private nextMsgSeq(msgId: string): number {
    const next = (this.msgSeqByReplyId.get(msgId) ?? 0) + 1;
    this.msgSeqByReplyId.set(msgId, next);
    return next;
  }

  private buildMessageBody(
    request: MessageRequest
  ): Record<string, unknown> {
    const msgSeq = this.nextMsgSeq(request.sequenceKey);
    const useMarkdown = this.markdownSupport || request.preferMarkdown === true;

    const body: Record<string, unknown> = useMarkdown
      ? {
          markdown: { content: request.content },
          msg_type: 2,
          msg_seq: msgSeq
        }
      : {
          content: request.content,
          msg_type: 0,
          msg_seq: msgSeq
        };

    if (request.mode === "reply") {
      body.msg_id = request.inboundMsgId;
    }

    return body;
  }

  private async toApiError(response: Response, operation: string): Promise<QqApiError> {
    const responseText = await response.text().catch(() => "");
    const payload = parseJsonRecord(responseText);
    const businessCode = readBusinessCode(payload);
    const retryAfterMs = readRetryAfterMs(response, payload, this.now());
    const businessSuffix = businessCode === undefined ? "" : ` (businessCode=${String(businessCode)})`;

    return new QqApiError(
      `QQ ${operation} failed: HTTP ${response.status}${businessSuffix}`,
      {
        httpStatus: response.status,
        ...(businessCode === undefined ? {} : { businessCode }),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs })
      }
    );
  }

  private async buildMediaUploadBody(artifact: MediaArtifact): Promise<Record<string, unknown>> {
    if (artifact.sourceUrl.startsWith("http://") || artifact.sourceUrl.startsWith("https://")) {
      return { url: artifact.sourceUrl };
    }

    if (existsSync(artifact.localPath)) {
      const stat = statSync(artifact.localPath);
      const limitBytes = this.getFileSizeLimitBytes(artifact.kind);
      if (stat.size > limitBytes) {
        const limitMb = (limitBytes / 1024 / 1024).toFixed(0);
        const actualMb = (stat.size / 1024 / 1024).toFixed(1);
        throw new Error(
          `QQ media upload size limit exceeded: file is ${actualMb}MB but QQ allows at most ${limitMb}MB for ${artifact.kind} (file: ${artifact.originalName})`
        );
      }
      return { file_data: readFileSync(artifact.localPath).toString("base64") };
    }

    throw new Error(`QQ media source not found: ${artifact.localPath}`);
  }

  /*
   * The remaining media helpers intentionally stay reply-only.  A proactive
   * completion is text-only and is routed through sendC2CProactive above.
   */
  private getFileSizeLimitBytes(kind: MediaArtifactKind): number {
    switch (kind) {
      case MediaArtifactKind.Image:
        return 10 * 1024 * 1024;  // 10 MB
      case MediaArtifactKind.Video:
        return 16 * 1024 * 1024;  // 16 MB
      case MediaArtifactKind.Audio:
        return 16 * 1024 * 1024;  // 16 MB
      case MediaArtifactKind.File:
      default:
        return 30 * 1024 * 1024;  // 30 MB
    }
  }

  private assertSupportedMediaFormat(artifact: MediaArtifact): void {
    const name = artifact.originalName || artifact.localPath || artifact.sourceUrl || "";
    const ext = name.split(".").pop()?.toLowerCase() ?? "";

    const SUPPORTED: Record<MediaArtifactKind, string[]> = {
      [MediaArtifactKind.Image]: ["png", "jpg", "jpeg"],
      [MediaArtifactKind.Video]: ["mp4"],
      [MediaArtifactKind.Audio]: ["silk", "wav", "mp3", "flac"],
      [MediaArtifactKind.File]:  []
    };

    const allowed = SUPPORTED[artifact.kind];
    if (allowed.length > 0 && !allowed.includes(ext)) {
      throw new Error(
        `QQ media format not supported: .${ext} is not accepted for ${artifact.kind} (QQ only supports: ${allowed.join(", ")}). File: ${name}`
      );
    }
  }

  private mapMediaFileType(kind: MediaArtifactKind): number {
    switch (kind) {
      case MediaArtifactKind.Image:
        return 1;
      case MediaArtifactKind.Video:
        return 2;
      case MediaArtifactKind.Audio:
        return 3;
      case MediaArtifactKind.File:
      default:
        return 4;
    }
  }
}

type MessageRequest =
  | {
      mode: "reply";
      content: string;
      inboundMsgId: string;
      preferMarkdown?: boolean;
      sequenceKey: string;
    }
  | {
      mode: "proactive";
      content: string;
      preferMarkdown?: boolean;
      sequenceKey: string;
    };

function assertNonEmpty(value: string, fieldName: string): void {
  if (!value.trim()) {
    throw new TypeError(`QQ ${fieldName} must be a non-empty string`);
  }
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  if (!text) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readBusinessCode(payload: Record<string, unknown> | null): string | number | undefined {
  if (!payload) {
    return undefined;
  }

  for (const candidate of [payload, payload.data, payload.error]) {
    if (!isRecord(candidate)) {
      continue;
    }
    for (const key of ["businessCode", "business_code", "err_code", "errorCode", "error_code", "code"]) {
      const value = candidate[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }
  }

  return undefined;
}

function readRetryAfterMs(
  response: Response,
  payload: Record<string, unknown> | null,
  nowMs: number
): number | undefined {
  const headerValue = response.headers.get("retry-after");
  const headerRetryAfterMs = parseRetryAfterHeader(headerValue, nowMs);
  if (headerRetryAfterMs !== undefined) {
    return headerRetryAfterMs;
  }

  for (const candidate of [payload, payload?.data, payload?.error]) {
    if (!isRecord(candidate)) {
      continue;
    }

    const milliseconds = candidate.retryAfterMs ?? candidate.retry_after_ms;
    const parsedMilliseconds = parseFiniteNonNegativeNumber(milliseconds);
    if (parsedMilliseconds !== undefined) {
      return parsedMilliseconds;
    }

    const seconds = candidate.retryAfter ?? candidate.retry_after;
    const parsedSeconds = parseFiniteNonNegativeNumber(seconds);
    if (parsedSeconds !== undefined) {
      return parsedSeconds * 1_000;
    }
  }

  return undefined;
}

function parseRetryAfterHeader(value: string | null, nowMs: number): number | undefined {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) {
    return Math.max(0, timestamp - nowMs);
  }

  return undefined;
}

function parseFiniteNonNegativeNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
