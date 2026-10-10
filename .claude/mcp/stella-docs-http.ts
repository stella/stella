import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createStellaDocsServer } from "./server";

const HTTP_HOST = process.env["STELLA_DOCS_HOST"] ?? "127.0.0.1";
const DEFAULT_PORT = 8765;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_SWEEP_MS = 60 * 1000;
const MAX_REQUEST_BYTES = 1024 * 1024;

const portValue = process.env["STELLA_DOCS_PORT"] ?? String(DEFAULT_PORT);
const port = Number(portValue);

if (HTTP_HOST !== "127.0.0.1") {
  process.stderr.write(
    `[stella-docs] Refusing to bind HTTP server to ${HTTP_HOST}; STELLA_DOCS_HOST must be 127.0.0.1.\n`,
  );
  process.exit(1);
}

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  process.stderr.write(
    `[stella-docs] Invalid STELLA_DOCS_PORT: ${portValue}. Expected an integer from 1 to 65535.\n`,
  );
  process.exit(1);
}

type Session = {
  server: ReturnType<typeof createStellaDocsServer>;
  transport: StreamableHTTPServerTransport;
  lastActive: number;
};

const sessions = new Map<string, Session>();
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const sendError = (
  response: ServerResponse,
  status: number,
  message: string,
) => {
  sendJson(response, status, {
    jsonrpc: "2.0",
    error: { code: -32_000, message },
    id: null,
  });
};

const readJsonBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error("Request body exceeds 1 MiB");
    }
    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown;
};

const getSessionId = (request: IncomingMessage) => {
  const value = request.headers["mcp-session-id"];
  return Array.isArray(value) ? value.at(0) : value;
};

const httpServer = createServer(async (request, response) => {
  if (!request.headers.host || !allowedHosts.has(request.headers.host)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (request.method === "GET" && url.pathname === "/healthz") {
    if (url.searchParams.get("details") === "1") {
      sendJson(response, 200, { status: "ok", sessions: sessions.size });
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }

  if (url.pathname !== "/mcp") {
    response.writeHead(404).end("Not found");
    return;
  }

  try {
    const sessionId = getSessionId(request);
    const existingSession = sessionId ? sessions.get(sessionId) : undefined;

    if (existingSession) {
      existingSession.lastActive = Date.now();
      // A successful DELETE ends the session through onsessionclosed; a rejected one must keep it.
      await existingSession.transport.handleRequest(request, response);
      return;
    }

    if (sessionId) {
      sendError(response, 404, "Session not found");
      return;
    }

    if (request.method !== "POST") {
      sendError(response, 400, "Missing MCP session ID");
      return;
    }

    const body = await readJsonBody(request);
    if (!isInitializeRequest(body)) {
      sendError(response, 400, "Expected an MCP initialization request");
      return;
    }

    const server = createStellaDocsServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (initializedSessionId) => {
        sessions.set(initializedSessionId, session);
      },
      onsessionclosed: (closedSessionId) => {
        sessions.delete(closedSessionId);
      },
    });
    const session: Session = { server, transport, lastActive: Date.now() };
    // The SDK's HTTP transport declares optional callbacks without `| undefined`,
    // which this package's exactOptionalPropertyTypes rejects; the runtime shape is a Transport.
    await server.connect(transport as Transport);
    await transport.handleRequest(request, response, body);
  } catch (error) {
    process.stderr.write(
      `[stella-docs] HTTP request failed: ${String(error)}\n`,
    );
    if (!response.headersSent) {
      sendError(response, 500, "Internal server error");
    }
  }
});

const sweepTimer = setInterval(() => {
  const staleBefore = Date.now() - SESSION_IDLE_MS;
  for (const [sessionId, session] of sessions) {
    if (session.lastActive < staleBefore) {
      sessions.delete(sessionId);
      void session.server.close();
    }
  }
}, SESSION_SWEEP_MS);
sweepTimer.unref();

const shutdown = async () => {
  clearInterval(sweepTimer);
  await Promise.allSettled(
    [...sessions.values()].map(({ server }) => server.close()),
  );
  sessions.clear();
  httpServer.close(() => process.exit(0));
};

const handleSignal = () => {
  shutdown().catch((error: unknown) => {
    process.stderr.write(`[stella-docs] Shutdown failed: ${String(error)}\n`);
    process.exit(1);
  });
};

process.once("SIGINT", handleSignal);
process.once("SIGTERM", handleSignal);

httpServer.listen(port, HTTP_HOST, () => {
  process.stderr.write(
    `[stella-docs] HTTP server listening on http://${HTTP_HOST}:${port}/mcp\n`,
  );
});
