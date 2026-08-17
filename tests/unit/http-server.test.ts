import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBridgeHttpServer,
  createInternalTurnEventServer
} from "../../apps/bridge-daemon/src/http-server.js";
import { TurnEventType } from "../../packages/domain/src/message.js";

describe("internal turn event server", () => {
  const servers: Array<{ close: () => void }> = [];

  afterEach(() => {
    while (servers.length > 0) {
      servers.pop()?.close();
    }
  });

  it("accepts codex turn events on the internal route", async () => {
    const payloads: unknown[] = [];
    const server = createInternalTurnEventServer({
      routePath: "/internal/codex-turn-events",
      ingress: {
        dispatchTurnEvent: async (payload) => {
          payloads.push(payload);
        }
      }
    });
    servers.push(server);

    const response = await new Promise<{ statusCode: number }>((resolve) => {
      server.emit(
        "request",
        {
          method: "POST",
          url: "/internal/codex-turn-events",
          socket: { remoteAddress: "127.0.0.1" },
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from(
              JSON.stringify({
                sessionKey: "qqbot:default::qq:c2c:abc-123",
                turnId: "turn-1",
                sequence: 1,
                eventType: TurnEventType.Completed,
                createdAt: "2026-04-12T12:00:00.000Z",
                isFinal: true,
                payload: {
                  fullText: "完整结果",
                  completionReason: "stable"
                }
              })
            );
          }
        } as never,
        {
          statusCode: 200,
          end: function () {
            resolve({ statusCode: this.statusCode });
          }
        }
      );
    });

    expect(response.statusCode).toBe(202);
    expect(payloads).toHaveLength(1);
  });

  it("rejects non-local callers", async () => {
    const server = createInternalTurnEventServer({
      routePath: "/internal/codex-turn-events",
      ingress: {
        dispatchTurnEvent: vi.fn()
      }
    });
    servers.push(server);

    const response = await new Promise<{ statusCode: number }>((resolve) => {
      server.emit(
        "request",
        {
          method: "POST",
          url: "/internal/codex-turn-events",
          socket: { remoteAddress: "10.0.0.8" },
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from("{}");
          }
        },
        {
          statusCode: 200,
          end: function () {
            resolve({ statusCode: this.statusCode });
          }
        }
      );
    });

    expect(response.statusCode).toBe(403);
  });

  it("supports multiple json routes in one bridge http server", async () => {
    const payloads: unknown[] = [];
    const server = createBridgeHttpServer([
      {
        routePath: "/internal/codex-turn-events",
        allowOnlyLocal: true,
        dispatchPayload: async (payload) => {
          payloads.push({ route: "internal", payload });
        }
      },
      {
        routePath: "/webhooks/weixin",
        dispatchPayload: async (payload) => {
          payloads.push({ route: "weixin", payload });
        }
      }
    ]);
    servers.push(server);

    const response = await new Promise<{ statusCode: number }>((resolve) => {
      server.emit(
        "request",
        {
          method: "POST",
          url: "/webhooks/weixin",
          socket: { remoteAddress: "10.0.0.8" },
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from(JSON.stringify({ text: "hello" }));
          }
        } as never,
        {
          statusCode: 200,
          end: function () {
            resolve({ statusCode: this.statusCode });
          }
        }
      );
    });

    expect(response.statusCode).toBe(202);
    expect(payloads).toEqual([{ route: "weixin", payload: { text: "hello" } }]);
  });

  it("serves health only to loopback GET callers and reports unhealthy status", async () => {
    const health = {
      ok: false,
      qqGateway: {
        connected: false,
        authenticated: false,
        accounts: {
          "qqbot:main": { connected: false, authenticated: false }
        }
      }
    };
    const getHealth = vi.fn().mockReturnValue(health);
    const server = createBridgeHttpServer([
      {
        routePath: "/health",
        getHealth
      }
    ]);
    servers.push(server);

    const localResponse = await new Promise<{ statusCode: number; body: string }>((resolve) => {
      server.emit(
        "request",
        {
          method: "GET",
          url: "/health",
          socket: { remoteAddress: "127.0.0.1" },
          [Symbol.asyncIterator]: async function* () {}
        } as never,
        {
          statusCode: 200,
          end: function (body?: string) {
            resolve({ statusCode: this.statusCode, body: body ?? "" });
          }
        }
      );
    });

    expect(localResponse.statusCode).toBe(503);
    expect(JSON.parse(localResponse.body)).toEqual(health);
    expect(getHealth).toHaveBeenCalledTimes(1);

    const remoteResponse = await new Promise<{ statusCode: number; body: string }>((resolve) => {
      server.emit(
        "request",
        {
          method: "GET",
          url: "/health",
          socket: { remoteAddress: "10.0.0.8" },
          [Symbol.asyncIterator]: async function* () {}
        } as never,
        {
          statusCode: 200,
          end: function (body?: string) {
            resolve({ statusCode: this.statusCode, body: body ?? "" });
          }
        }
      );
    });

    expect(remoteResponse).toEqual({ statusCode: 403, body: "forbidden" });
    expect(getHealth).toHaveBeenCalledTimes(1);

    const postResponse = await new Promise<{ statusCode: number; body: string }>((resolve) => {
      server.emit(
        "request",
        {
          method: "POST",
          url: "/health",
          socket: { remoteAddress: "127.0.0.1" },
          [Symbol.asyncIterator]: async function* () {}
        } as never,
        {
          statusCode: 200,
          end: function (body?: string) {
            resolve({ statusCode: this.statusCode, body: body ?? "" });
          }
        }
      );
    });

    expect(postResponse).toEqual({ statusCode: 405, body: "method not allowed" });
    expect(getHealth).toHaveBeenCalledTimes(1);
  });
});
