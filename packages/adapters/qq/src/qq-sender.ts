import type { DeliveryRecord, MediaArtifact, OutboundDraft } from "../../../domain/src/message.js";
import type { QqEgressPort } from "../../../ports/src/qq.js";
import type { C2CTextProactiveRequest, QqApiClient } from "./qq-api-client.js";
import { buildMediaArtifactFromReference, parseQqMediaSegments } from "./qq-media-parser.js";

const QQ_MARKDOWN_DEFAULT_IMAGE_SIZE = { width: 512, height: 512 };

type QqChunkMode = "plain" | "markdown";

type QqReplyTextMode = {
  mode: "reply";
  inboundMsgId: string;
};

type QqProactiveTextMode = {
  mode: "proactive";
};

type QqTextDeliveryMode = QqReplyTextMode | QqProactiveTextMode;

type QqProactiveDraft = Omit<OutboundDraft, "replyToMessageId"> & {
  replyToMessageId?: never;
};

type QqApiPort = Pick<
  QqApiClient,
  "sendC2CReply" | "sendC2CProactive" | "sendGroupMessage" | "sendC2CMediaArtifact" | "sendGroupMediaArtifact"
>;

export function chunkTextForQq(text: string, limit = 5000, mode: QqChunkMode = "plain"): string[] {
  if (mode === "markdown") {
    return chunkMarkdownTextForQq(text, limit);
  }

  const chunks: string[] = [];

  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }

  return chunks.length > 0 ? chunks : [""];
}

export class QqSender implements QqEgressPort {
  constructor(private readonly apiClient?: QqApiPort) {}

  async deliver(draft: OutboundDraft): Promise<DeliveryRecord> {
    const replyToMessageId = draft.replyToMessageId?.trim();
    if (!replyToMessageId) {
      throw new Error("QQ reply requires the real inbound replyToMessageId");
    }

    const providerMessageId = await this.deliverThroughApiClient(draft);

    return {
      jobId: draft.draftId,
      sessionKey: draft.sessionKey,
      providerMessageId,
      deliveredAt: draft.createdAt
    };
  }

  /**
   * Deliver a Desktop completion as a C2C proactive text message.
   *
   * This is deliberately a separate entry point from `deliver`: completion
   * notifications have no current QQ inbound event and must never inherit a
   * cached reply id or use the draft id as `msg_id`.
   */
  async deliverProactive(draft: QqProactiveDraft): Promise<DeliveryRecord> {
    if (!this.apiClient) {
      return {
        jobId: draft.draftId,
        sessionKey: draft.sessionKey,
        providerMessageId: null,
        deliveredAt: draft.createdAt
      };
    }

    const target = parseSessionTarget(draft.sessionKey);
    if (target.chatType !== "c2c" || !target.peerId) {
      throw new Error("QQ proactive delivery supports C2C targets only");
    }
    if (draft.mediaArtifacts?.length || parseQqMediaSegments(draft.text).some((segment) => segment.type === "media")) {
      throw new Error("QQ proactive delivery supports text-only completion notifications");
    }

    const providerMessageId = await this.sendTextSegment(
      target,
      normalizeTextSegmentForQq(draft.text),
      { mode: "proactive" }
    );

    return {
      jobId: draft.draftId,
      sessionKey: draft.sessionKey,
      providerMessageId,
      deliveredAt: draft.createdAt
    };
  }

  private async sendTextSegment(
    target: { chatType: string; peerId: string },
    text: string,
    deliveryMode: QqTextDeliveryMode
  ): Promise<string | null> {
    if (!text) {
      return null;
    }

    let lastProviderMessageId: string | null = null;
    const preferMarkdown = shouldUseMarkdownForQq(text);
    const chunkMode: QqChunkMode = preferMarkdown ? "markdown" : "plain";

    for (const chunk of chunkTextForQq(text, 5000, chunkMode)) {
      if (!chunk) {
        continue;
      }

      if (target.chatType === "c2c") {
        if (deliveryMode.mode === "reply") {
          lastProviderMessageId = await this.apiClient!.sendC2CReply({
            openid: target.peerId,
            inboundMsgId: deliveryMode.inboundMsgId,
            content: chunk,
            preferMarkdown
          });
        } else {
          const request: C2CTextProactiveRequest = {
            openid: target.peerId,
            content: chunk,
            preferMarkdown
          };
          lastProviderMessageId = await this.apiClient!.sendC2CProactive(request);
        }
        continue;
      }

      if (target.chatType === "group") {
        if (deliveryMode.mode !== "reply") {
          throw new Error("QQ proactive delivery supports C2C targets only");
        }
        lastProviderMessageId = await this.apiClient!.sendGroupMessage(target.peerId, chunk, deliveryMode.inboundMsgId, {
          preferMarkdown
        });
        continue;
      }
    }

    return lastProviderMessageId;
  }

  private async sendMediaArtifact(
    target: { chatType: string; peerId: string },
    artifact: MediaArtifact,
    replyToMessageId: string
  ): Promise<string | null> {
    if (target.chatType === "c2c" && this.apiClient?.sendC2CMediaArtifact) {
      return this.apiClient.sendC2CMediaArtifact(target.peerId, artifact, replyToMessageId);
    }

    if (target.chatType === "group" && this.apiClient?.sendGroupMediaArtifact) {
      return this.apiClient.sendGroupMediaArtifact(target.peerId, artifact, replyToMessageId);
    }

    return null;
  }

  private buildMediaFailureText(artifact: MediaArtifact, error: unknown): string {
    const filename = artifact.originalName || artifact.localPath || artifact.sourceUrl || "未知附件";
    const reason = error instanceof Error ? error.message : String(error);
    return `媒体发送失败：${filename}\n${reason}`;
  }

  private async deliverThroughApiClient(draft: OutboundDraft): Promise<string | null> {
    if (!this.apiClient) {
      return null;
    }

    const replyToMessageId = draft.replyToMessageId?.trim();
    if (!replyToMessageId) {
      throw new Error("QQ reply requires the real inbound replyToMessageId");
    }
    const target = parseSessionTarget(draft.sessionKey);
    let lastProviderMessageId: string | null = null;
    const deliveredArtifactKeys = new Set<string>();

    for (const segment of parseQqMediaSegments(draft.text)) {
      if (segment.type === "text") {
        lastProviderMessageId = await this.sendTextSegment(
          target,
          normalizeTextSegmentForQq(segment.text),
          { mode: "reply", inboundMsgId: replyToMessageId }
        );
        continue;
      }

      const artifact = buildMediaArtifactFromReference(segment.reference);
      deliveredArtifactKeys.add(buildArtifactKey(artifact));
      try {
        lastProviderMessageId = await this.sendMediaArtifact(
          target,
          artifact,
          replyToMessageId
        );
      } catch (error) {
        lastProviderMessageId = await this.sendTextSegment(
          target,
          this.buildMediaFailureText(artifact, error),
          { mode: "reply", inboundMsgId: replyToMessageId }
        );
      }
    }

    if (draft.mediaArtifacts?.length) {
      for (const artifact of draft.mediaArtifacts) {
        const artifactKey = buildArtifactKey(artifact);
        if (deliveredArtifactKeys.has(artifactKey)) {
          continue;
        }
        deliveredArtifactKeys.add(artifactKey);
        try {
        lastProviderMessageId = await this.sendMediaArtifact(target, artifact, replyToMessageId);
        } catch (error) {
          lastProviderMessageId = await this.sendTextSegment(
            target,
            this.buildMediaFailureText(artifact, error),
            { mode: "reply", inboundMsgId: replyToMessageId }
          );
        }
      }
    }

    if (lastProviderMessageId !== null) {
      return lastProviderMessageId;
    }

    return this.sendTextSegment(
      target,
      normalizeTextSegmentForQq(draft.text),
      { mode: "reply", inboundMsgId: replyToMessageId }
    );
  }

}

function normalizeTextSegmentForQq(text: string): string {
  if (!text) {
    return text;
  }

  return text.replace(/!\[(.*?)\]\((https?:\/\/[^)]+)\)/g, (_match, altText: string, url: string) => {
    if (/^#\d+px\s+#\d+px$/i.test(altText.trim())) {
      return `![${altText}](${url})`;
    }

    return `![#${QQ_MARKDOWN_DEFAULT_IMAGE_SIZE.width}px #${QQ_MARKDOWN_DEFAULT_IMAGE_SIZE.height}px](${url})`;
  });
}

function shouldUseMarkdownForQq(text: string): boolean {
  if (!text.trim()) {
    return false;
  }

  return (
    /```[\s\S]*```/.test(text) ||
    /^\|.+\|\s*$/m.test(text) ||
    /^\s*#{1,6}\s/m.test(text) ||
    /^\s*>\s/m.test(text) ||
    /^\s*[-*+]\s/m.test(text) ||
    /^\s*\d+\.\s/m.test(text) ||
    /!\[[^\]]*\]\([^)]+\)/.test(text) ||
    /`[^`\n]+`/.test(text)
  );
}

function chunkMarkdownTextForQq(text: string, limit: number): string[] {
  if (!text) {
    return [""];
  }

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const chunks: string[] = [];
  let current = "";
  let inFence = false;
  let fenceHeader = "";

  const pushCurrent = (reopenFence: boolean): void => {
    if (!current.trim()) {
      current = reopenFence && fenceHeader ? `${fenceHeader}\n` : "";
      return;
    }

    let chunk = current;
    if (inFence && fenceHeader) {
      if (!chunk.endsWith("\n")) {
        chunk += "\n";
      }
      chunk += "```";
    }
    chunks.push(chunk);
    current = reopenFence && inFence && fenceHeader ? `${fenceHeader}\n` : "";
  };

  const appendLine = (line: string): void => {
    current = current ? `${current}\n${line}` : line;
  };

  for (const line of lines) {
    const trimmedLine = line.trim();
    const isFenceLine = /^```/.test(trimmedLine);

    if (!current) {
      appendLine(line);
    } else if (`${current}\n${line}`.length > limit) {
      pushCurrent(true);
      if (line.length > limit) {
        const oversizedParts = splitOversizedMarkdownLine(line, limit, inFence, fenceHeader);
        if (oversizedParts.length > 1) {
          chunks.push(...oversizedParts.slice(0, -1));
          current = oversizedParts.at(-1) ?? "";
        } else {
          current = oversizedParts[0] ?? "";
        }
      } else {
        appendLine(line);
      }
    } else {
      appendLine(line);
    }

    if (isFenceLine) {
      if (!inFence) {
        fenceHeader = trimmedLine;
        inFence = true;
      } else {
        inFence = false;
        fenceHeader = "";
      }
    }
  }

  if (current.trim()) {
    if (inFence && fenceHeader) {
      if (!current.endsWith("\n")) {
        current += "\n";
      }
      current += "```";
    }
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [""];
}

function splitOversizedMarkdownLine(
  line: string,
  limit: number,
  inFence: boolean,
  fenceHeader: string
): string[] {
  const parts: string[] = [];
  let rest = line;

  while (rest.length > limit) {
    const chunkBody = rest.slice(0, limit);
    if (inFence && fenceHeader) {
      parts.push(`${fenceHeader}\n${chunkBody}\n\`\`\``);
      rest = `${fenceHeader}\n${rest.slice(limit)}`;
      break;
    }
    parts.push(chunkBody);
    rest = rest.slice(limit);
  }

  if (rest) {
    parts.push(rest);
  }

  return parts;
}

function parseSessionTarget(sessionKey: string): { chatType: string; peerId: string } {
  const [, peerKey = ""] = sessionKey.split("::");
  const segments = peerKey.split(":");

  return {
    chatType: segments[1] ?? "",
    peerId: segments.slice(2).join(":")
  };
}

function buildArtifactKey(artifact: MediaArtifact): string {
  return [
    artifact.kind,
    artifact.localPath || "",
    artifact.sourceUrl || "",
    artifact.originalName || ""
  ].join("::");
}
