import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";

export type JsonRoute = {
  routePath: string;
  dispatchPayload(payload: unknown): Promise<void>;
  onDispatchError?: (error: Error, payload: unknown) => void;
  allowOnlyLocal?: boolean;
};

export type HealthRoute = {
  routePath: string;
  getHealth(): unknown | Promise<unknown>;
};

type JsonServerDeps = {
  routes: Array<JsonRoute | HealthRoute>;
};

type QqWebhookServerDeps = {
  webhookPath: string;
  ingress: {
    dispatchPayload(payload: unknown): Promise<void>;
  };
  onDispatchError?: (error: Error, payload: unknown) => void;
};

type InternalTurnEventServerDeps = {
  routePath: string;
  ingress: {
    dispatchTurnEvent(payload: unknown): Promise<void>;
  };
  onDispatchError?: (error: Error, payload: unknown) => void;
};

export function createQqWebhookServer(deps: QqWebhookServerDeps): Server {
  return createJsonServer({
    routes: [
      {
        routePath: deps.webhookPath,
        dispatchPayload: deps.ingress.dispatchPayload,
        onDispatchError: deps.onDispatchError
      }
    ]
  });
}

export function createInternalTurnEventServer(deps: InternalTurnEventServerDeps): Server {
  return createJsonServer({
    routes: [
      {
        routePath: deps.routePath,
        dispatchPayload: deps.ingress.dispatchTurnEvent,
        onDispatchError: deps.onDispatchError,
        allowOnlyLocal: true
      }
    ]
  });
}

export function createBridgeHttpServer(routes: Array<JsonRoute | HealthRoute>): Server {
  return createJsonServer({ routes });
}

function createJsonServer(deps: JsonServerDeps): Server {
  return createServer(async (request, response) => {
    const route = deps.routes.find((candidate) => candidate.routePath === request.url);
    if (!route) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }

    if (isHealthRoute(route)) {
      if (!isLocalRequest(request)) {
        response.statusCode = 403;
        response.end("forbidden");
        return;
      }

      if (request.method !== "GET") {
        response.statusCode = 405;
        response.end("method not allowed");
        return;
      }

      try {
        const payload = await route.getHealth();
        writeJson(response, isHealthyPayload(payload) ? 200 : 503, payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : "health check failed";
        writeJson(response, 500, { ok: false, error: message });
      }
      return;
    }

    if (route.allowOnlyLocal && !isLocalRequest(request)) {
      response.statusCode = 403;
      response.end("forbidden");
      return;
    }

    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end("method not allowed");
      return;
    }

    const chunks: Buffer[] = [];

    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      response.statusCode = 400;
      response.end(error instanceof Error ? error.message : "invalid request");
      return;
    }

    Promise.resolve()
      .then(() => route.dispatchPayload(payload))
      .catch((error) => {
        const normalized =
          error instanceof Error ? error : new Error(typeof error === "string" ? error : "dispatch failed");
        route.onDispatchError?.(normalized, payload);
      });

    response.statusCode = 202;
    response.end("accepted");
  });
}

function isHealthRoute(route: JsonRoute | HealthRoute): route is HealthRoute {
  return "getHealth" in route;
}

function isHealthyPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || !("ok" in payload)) {
    return true;
  }

  return (payload as { ok?: unknown }).ok !== false;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader?.("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function isLocalRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  if (!address) {
    return false;
  }

  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
