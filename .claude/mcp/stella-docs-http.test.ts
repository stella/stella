import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, test } from "bun:test";
import { connect, createServer } from "node:net";

const children = new Set<ReturnType<typeof Bun.spawn>>();

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

const waitForHealth = async (baseUrl: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${baseUrl}/healthz`).catch(() => undefined);
    if (response?.ok) {
      expect(await response.text()).toBe("ok");
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error("HTTP MCP server did not become healthy");
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

const startHttpServer = async () => {
  const port = await getFreePort();
  const child = Bun.spawn([process.execPath, "run", "stella-docs-http.ts"], {
    cwd: import.meta.dir,
    env: { ...process.env, STELLA_DOCS_PORT: String(port) },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  children.add(child);
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  return { baseUrl, child };
};

const connectHttpClient = async (baseUrl: string, name: string) => {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
  );
  const client = new Client({ name, version: "1.0.0" });
  // Same SDK typing gap as the server transport under exactOptionalPropertyTypes.
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
    const post = (body: string) =>
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
    expect(
      ((await malformed.json()) as { error: { code: number } }).error.code,
    ).toBe(-32_700);
    const oversized = await post(
      JSON.stringify({ padding: "x".repeat(1024 * 1024 + 1) }),
    );
    expect(oversized.status).toBe(413);
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
});
