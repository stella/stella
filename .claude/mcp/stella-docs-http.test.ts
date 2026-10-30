import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, test } from "bun:test";
import { connect, createServer } from "node:net";

const children = new Set<ReturnType<typeof Bun.spawn>>();
const UNBOUNDED_UPLOAD_ITERATIONS = 200;
// The repeated-upload server runs with a smaller body limit, so each round
// keeps the same shape (past the 8x drain bound, never complete) without
// pushing gigabytes through loopback inside one test timeout.
const REPEATED_UPLOAD_LIMIT_BYTES = 64 * 1024;
const DECLARED_UPLOAD_BYTES = 100 * REPEATED_UPLOAD_LIMIT_BYTES;
const SENT_UPLOAD_BYTES = 10 * REPEATED_UPLOAD_LIMIT_BYTES;

const getFreePort = async () =>
  await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate a local port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

// The server writes this line from its `listen` callback, once the socket is
// bound, so it is the ready signal. Stderr is drained to its end, so the child
// never blocks on a full pipe; an exit before the line fails with its output.
const waitForListening = async (
  stderr: ReadableStream<Uint8Array>,
  baseUrl: string,
) => {
  const announcement = `HTTP server listening on ${baseUrl}/mcp`;
  const listening = Promise.withResolvers<undefined>();
  const drain = async () => {
    const decoder = new TextDecoder();
    let output = "";
    let announced = false;
    for await (const chunk of stderr) {
      if (!announced) {
        output += decoder.decode(chunk, { stream: true });
        announced = output.includes(announcement);
        if (announced) {
          listening.resolve(undefined);
        }
      }
    }
    if (!announced) {
      listening.reject(
        new Error(`HTTP MCP server exited before listening:\n${output}`),
      );
    }
  };
  drain().catch((error: unknown) => {
    listening.reject(error);
  });
  await listening.promise;
};

const expectHealthy = async (baseUrl: string) => {
  const response = await fetch(`${baseUrl}/healthz`);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ok");
};

const getSessionCount = async (baseUrl: string) => {
  const response = await fetch(`${baseUrl}/healthz?details=1`);
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(body).toEqual({ status: "ok", sessions: expect.any(Number) });
  if (
    typeof body !== "object" ||
    body === null ||
    !("sessions" in body) ||
    typeof body.sessions !== "number"
  ) {
    throw new Error("Health details omitted the session count");
  }
  return body.sessions;
};

const startHttpServer = async (env: Record<string, string> = {}) => {
  const port = await getFreePort();
  const child = Bun.spawn([process.execPath, "run", "stella-docs-http.ts"], {
    cwd: import.meta.dir,
    env: { ...process.env, ...env, STELLA_DOCS_PORT: String(port) },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  children.add(child);
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForListening(child.stderr, baseUrl);
  await expectHealthy(baseUrl);
  return { baseUrl, child };
};

const connectHttpClient = async (baseUrl: string, name: string) => {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
  );
  const client = new Client({ name, version: "1.0.0" });
  // Same SDK typing gap as the server transport under exactOptionalPropertyTypes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SDK typing gap described above
  await client.connect(transport as Transport);
  return { client, transport };
};

const listStdioTools = async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", "stella-docs.ts"],
    cwd: import.meta.dir,
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-comparison", version: "1.0.0" });
  try {
    await client.connect(transport);
    return (await client.listTools()).tools.map(({ name }) => name).toSorted();
  } finally {
    await client.close();
  }
};

const readEarlyUploadResponse = async (port: string) =>
  await new Promise<string>((resolve, reject) => {
    let received = "";
    let settled = false;
    const socket = connect(Number(port), "127.0.0.1", () => {
      socket.write(
        `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\ncontent-type: application/json\r\ncontent-length: ${DECLARED_UPLOAD_BYTES}\r\n\r\n`,
      );
      // Ten body limits of a declared hundred: past the drain bound, while the
      // upload remains incomplete. Receiving a response proves the server stopped reading.
      socket.write(Buffer.alloc(SENT_UPLOAD_BYTES, 120));
    });
    const settleFromResponse = () => {
      const lineEnd = received.indexOf("\r\n");
      if (lineEnd === -1) {
        return false;
      }
      settled = true;
      resolve(received.slice(0, lineEnd));
      socket.destroy();
      return true;
    };
    socket.on("data", (data) => {
      received += data.toString();
      settleFromResponse();
    });
    socket.on("error", (error) => {
      if (settled || settleFromResponse()) {
        return;
      }
      reject(error);
    });
    socket.on("close", () => {
      if (!settled && !settleFromResponse()) {
        reject(
          new Error("Connection closed before an HTTP status line arrived"),
        );
      }
    });
  });

afterEach(async () => {
  for (const child of children) {
    child.kill("SIGTERM");
    await child.exited;
  }
  children.clear();
});

describe("shared documentation MCP HTTP server", () => {
  test("serves independent real SDK sessions with the stdio tool set", async () => {
    const { baseUrl } = await startHttpServer();
    const [firstConnection, secondConnection, stdioTools] = await Promise.all([
      connectHttpClient(baseUrl, "http-first"),
      connectHttpClient(baseUrl, "http-second"),
      listStdioTools(),
    ]);
    const { client: first, transport: firstTransport } = firstConnection;
    const { client: second, transport: secondTransport } = secondConnection;

    try {
      const [firstTools, secondTools] = await Promise.all([
        first.listTools(),
        second.listTools(),
      ]);
      expect(firstTools.tools.map(({ name }) => name).toSorted()).toEqual(
        stdioTools,
      );
      expect(secondTools.tools.map(({ name }) => name).toSorted()).toEqual(
        stdioTools,
      );
      const [firstSources, secondSources] = await Promise.all([
        first.callTool({ name: "list_doc_sources", arguments: {} }),
        second.callTool({ name: "list_doc_sources", arguments: {} }),
      ]);
      expect(firstSources.isError).not.toBe(true);
      expect(secondSources.isError).not.toBe(true);
      expect(await getSessionCount(baseUrl)).toBe(2);

      await firstTransport.terminateSession();
      await first.close();
      expect((await second.listTools()).tools).not.toHaveLength(0);
      expect(await getSessionCount(baseUrl)).toBe(1);

      await secondTransport.terminateSession();
      await second.close();
      expect(await getSessionCount(baseUrl)).toBe(0);
    } finally {
      await first.close();
      await second.close();
    }
  });

  test("keeps a session when its DELETE request is rejected", async () => {
    const { baseUrl } = await startHttpServer();
    const { client, transport } = await connectHttpClient(baseUrl, "http-keep");
    try {
      const sessionId = transport.sessionId;
      expect(sessionId).toBeDefined();
      const rejected = await fetch(`${baseUrl}/mcp`, {
        method: "DELETE",
        headers: {
          "mcp-session-id": sessionId ?? "",
          "mcp-protocol-version": "1999-01-01",
        },
      });
      expect(rejected.status).toBeGreaterThanOrEqual(400);
      expect(await getSessionCount(baseUrl)).toBe(1);
      expect((await client.listTools()).tools).not.toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  test("rejects requests from an unrelated Origin", async () => {
    const { baseUrl } = await startHttpServer();
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "origin-check", version: "1.0.0" },
      },
    };
    const send = async (origin?: string) =>
      fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(origin === undefined ? {} : { origin }),
        },
        body: JSON.stringify(initialize),
      });
    expect((await send("http://evil.example")).status).toBe(403);
    expect((await send(baseUrl)).status).toBe(200);
    expect((await send()).status).toBe(200);
  });

  test("answers malformed and oversized bodies as client errors", async () => {
    const { baseUrl } = await startHttpServer();
    const post = async (body: string) =>
      fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body,
      });
    const malformed = await post("{not json");
    expect(malformed.status).toBe(400);
    const malformedBody: unknown = await malformed.json();
    expect(malformedBody).toMatchObject({ error: { code: -32_700 } });
    const oversized = await post(
      JSON.stringify({ padding: "x".repeat(1024 * 1024 + 1) }),
    );
    expect(oversized.status).toBe(413);
  });

  test("answers an unbounded upload with 413 before it finishes", async () => {
    const { baseUrl } = await startHttpServer();
    const { port } = new URL(baseUrl);
    // Half-open: the client does not close its side when the server's FIN
    // arrives, so only the server's linger bound can end the connection.
    const socket = connect(
      { port: Number(port), host: "127.0.0.1", allowHalfOpen: true },
      () => {
        socket.write(
          `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\ncontent-type: application/json\r\ncontent-length: ${100 * 1024 * 1024}\r\n\r\n`,
        );
        // Ten MiB of a declared hundred: past the drain bound, and the upload never completes.
        socket.write(Buffer.alloc(10 * 1024 * 1024, 120));
      },
    );
    // Upload bytes keep arriving after the answer, as from a client that does
    // not read until it has sent everything.
    const keepUploading = setInterval(() => {
      if (socket.writable) {
        socket.write(Buffer.alloc(256 * 1024, 120));
      }
    }, 20);
    const socketClosed = new Promise<void>((resolve) => {
      socket.once("close", () => {
        clearInterval(keepUploading);
        resolve();
      });
    });
    try {
      const statusLine = await new Promise<string>((resolve, reject) => {
        let received = "";
        socket.on("data", (data) => {
          received += data.toString();
          if (received.includes("\r\n")) {
            resolve(received.split("\r\n")[0] ?? "");
          }
        });
        // Before the status line any socket error is a failure; after it, the
        // server's close of the unfinished upload is expected.
        socket.on("error", (error) => {
          if (!received.includes("\r\n")) {
            reject(error);
          }
        });
      });
      expect(statusLine).toContain(" 413 ");
      // The server does not keep reading the unfinished upload indefinitely: it
      // drops the connection after its linger window, while the client is still
      // uploading. The test awaits that close itself; a server that kept the
      // upload open never closes it and fails on the test's default timeout.
      await socketClosed;
    } finally {
      clearInterval(keepUploading);
      socket.destroy();
    }
  });

  test("answers every repeated unbounded upload with a 413 status line first", async () => {
    const { baseUrl } = await startHttpServer({
      STELLA_DOCS_MAX_REQUEST_BYTES: String(REPEATED_UPLOAD_LIMIT_BYTES),
    });
    const { port } = new URL(baseUrl);
    expect(SENT_UPLOAD_BYTES).toBeLessThan(DECLARED_UPLOAD_BYTES);
    for (
      let iteration = 0;
      iteration < UNBOUNDED_UPLOAD_ITERATIONS;
      iteration += 1
    ) {
      expect(await readEarlyUploadResponse(port)).toBe(
        "HTTP/1.1 413 Payload Too Large",
      );
    }
  });

  test("applies the body limit to requests of an established session", async () => {
    const { baseUrl } = await startHttpServer();
    const { client, transport } = await connectHttpClient(
      baseUrl,
      "http-limit",
    );
    try {
      const oversized = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": transport.sessionId ?? "",
          "mcp-protocol-version": transport.protocolVersion ?? "2025-06-18",
        },
        body: JSON.stringify({ padding: "x".repeat(1024 * 1024 + 1) }),
      });
      expect(oversized.status).toBe(413);
      expect((await client.listTools()).tools).not.toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  test("answers a malformed request target and stays up", async () => {
    const { baseUrl } = await startHttpServer();
    const { port } = new URL(baseUrl);
    const statusLine = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), "127.0.0.1", () => {
        socket.write(
          `GET //[ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
        );
      });
      let received = "";
      socket.on("data", (data) => {
        received += data.toString();
      });
      socket.on("end", () => resolve(received.split("\r\n")[0] ?? ""));
      socket.on("error", reject);
    });
    expect(statusLine).toContain(" 400 ");
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
  });

  test("rejects requests with an unexpected Host header", async () => {
    const { baseUrl } = await startHttpServer();
    const response = await fetch(`${baseUrl}/healthz`, {
      headers: { Host: `evil.example:${new URL(baseUrl).port}` },
    });
    expect(response.status).toBe(403);
  });

  test("refuses to bind to a non-loopback host", async () => {
    const child = Bun.spawn([process.execPath, "run", "stella-docs-http.ts"], {
      cwd: import.meta.dir,
      env: { ...process.env, STELLA_DOCS_HOST: "0.0.0.0" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("must be 127.0.0.1");
  });

  test.each(["0", "-1", "1.5", "lots"])(
    "refuses a body limit of %p",
    async (limit) => {
      const child = Bun.spawn(
        [process.execPath, "run", "stella-docs-http.ts"],
        {
          cwd: import.meta.dir,
          env: { ...process.env, STELLA_DOCS_MAX_REQUEST_BYTES: limit },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).not.toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toContain(
        `Invalid STELLA_DOCS_MAX_REQUEST_BYTES: ${limit}.`,
      );
    },
  );
});
