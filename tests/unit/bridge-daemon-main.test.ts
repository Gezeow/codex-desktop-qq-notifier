import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { InboundMessage, TurnEvent } from "../../packages/domain/src/message.js";
import { hashIdentifierForLog } from "../../packages/domain/src/log-redaction.js";
import {
  buildBridgeHealthStatus,
  createIngressMessageHandler,
  resolveTurnEventOrchestrator
} from "../../apps/bridge-daemon/src/main.js";

function createMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: "msg-main-1",
    accountKey: "qqbot:default",
    sessionKey: "qqbot:default::qq:c2c:abc-123",
    peerKey: "qq:c2c:abc-123",
    chatType: "c2c",
    senderId: "abc-123",
    text: "hello",
    receivedAt: "2026-04-09T12:00:00.000Z",
    ...overrides
  };
}

describe("bridge daemon main", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes normal inbound messages to the orchestrator", async () => {
    const threadCommandHandler = {
      handleIfCommand: vi.fn().mockResolvedValue(false)
    };
    const orchestrator = {
      handleInbound: vi.fn().mockResolvedValue(undefined)
    };

    const handler = createIngressMessageHandler({
      threadCommandHandler: threadCommandHandler as any,
      orchestrator
    });

    const message = createMessage();
    await handler(message);

    expect(threadCommandHandler.handleIfCommand).toHaveBeenCalledWith(message);
    expect(orchestrator.handleInbound).toHaveBeenCalledWith(message);
  });

  it("logs inbound turn failures without rethrowing them", async () => {
    const threadCommandHandler = {
      handleIfCommand: vi.fn().mockResolvedValue(false)
    };
    const orchestrator = {
      handleInbound: vi.fn().mockRejectedValue(new Error("Codex desktop reply did not arrive before timeout"))
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handler = createIngressMessageHandler({
      threadCommandHandler: threadCommandHandler as any,
      orchestrator
    });

    await expect(handler(createMessage())).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      "[qq-codex-bridge] message handling failed",
      expect.objectContaining({
        messageId: "msg-main-1",
        sessionKeyHash: hashIdentifierForLog("qqbot:default::qq:c2c:abc-123"),
        error: "Codex desktop reply did not arrive before timeout"
      })
    );
  });

  it("routes turn events to the matching channel orchestrator based on session key", () => {
    const qq = { handleTurnEvent: vi.fn() };
    const weixin = { handleTurnEvent: vi.fn() };
    const event: TurnEvent = {
      sessionKey: "weixin:default::wx:c2c:wxid-1",
      turnId: "turn-1",
      sequence: 2,
      eventType: "turn.completed" as TurnEvent["eventType"],
      createdAt: "2026-04-15T03:30:00.000Z",
      isFinal: true,
      payload: {
        fullText: "<qqmedia>/tmp/demo.jpg</qqmedia>"
      }
    };

    const resolved = resolveTurnEventOrchestrator(event, {
      qq,
      weixin
    });

    expect(resolved).toBe(weixin);
  });

  it("routes turn events to the exact account orchestrator when multiple accounts are registered", () => {
    const qq = { handleTurnEvent: vi.fn() };
    const qqShop = { handleTurnEvent: vi.fn() };
    const weixinMain = { handleTurnEvent: vi.fn() };
    const event: TurnEvent = {
      sessionKey: "qqbot:shop::qq:c2c:openid-1",
      turnId: "turn-accounts-1",
      sequence: 1,
      eventType: "turn.completed" as TurnEvent["eventType"],
      createdAt: "2026-04-26T12:00:00.000Z",
      isFinal: true,
      payload: {
        fullText: "ok"
      }
    };

    const resolved = resolveTurnEventOrchestrator(event, {
      qq,
      byAccountKey: {
        "qqbot:shop": qqShop,
        "weixin:main": weixinMain
      }
    });

    expect(resolved).toBe(qqShop);
  });

  it("marks aggregate QQ health false until every account is connected and authenticated", () => {
    const status = buildBridgeHealthStatus([
      {
        accountKey: "qqbot:main",
        adapter: {
          ingress: {
            getHealth: () => ({ connected: true, authenticated: true })
          }
        }
      },
      {
        accountKey: "qqbot:shop",
        adapter: {
          ingress: {
            getHealth: () => ({ connected: true, authenticated: false })
          }
        }
      }
    ], {
      getHealth: () => ({
        running: true,
        initialized: true,
        healthy: true,
        targetConfigured: true,
        lastPollAt: "2026-08-16T03:00:00.000Z",
        lastCompletionAt: null,
        lastError: null
      })
    });

    expect(status).toEqual({
      ok: false,
      qqGateway: {
        connected: true,
        authenticated: false,
        accounts: {
          "qqbot:main": { connected: true, authenticated: true },
          "qqbot:shop": { connected: true, authenticated: false }
        }
      },
      completionMonitor: {
        running: true,
        initialized: true,
        healthy: true,
        targetConfigured: true,
        lastPollAt: "2026-08-16T03:00:00.000Z",
        lastCompletionAt: null,
        lastError: null
      }
    });
    expect(JSON.stringify(status)).not.toContain("token");
    expect(JSON.stringify(status)).not.toContain("OPENID");
  });

  it("baselines Desktop completion before gateway startup can delay the first task", () => {
    const mainPath = fileURLToPath(new URL("../../apps/bridge-daemon/src/main.ts", import.meta.url));
    const source = fs.readFileSync(mainPath, "utf8");

    expect(source.indexOf("await app.completionMonitor.start()"))
      .toBeLessThan(source.indexOf("await entry.adapter.ingress.start()"));
  });
});
