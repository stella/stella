import { describe, expect, test } from "bun:test";

import { MCP_STATELESS_ALLOW_HEADER } from "@/api/mcp/constants";

import {
  AUTHENTICATED_PROBES,
  evaluateDiscovery,
  evaluateInitialize,
  evaluateStreamRefusal,
  evaluateToolsList,
  evaluateUnauthenticated,
  summarize,
} from "./mcp-canary";

const REFUSAL = {
  allow: MCP_STATELESS_ALLOW_HEADER,
  contentType: "application/json",
  status: 405,
};

describe("evaluateStreamRefusal", () => {
  test("fails a stream answer, which per-request teardown truncates", () => {
    // The whole point of the probe: a 2xx that hands the client a body already
    // ended by teardown. Status alone reads as healthy, so the media type has
    // to decide.
    const result = evaluateStreamRefusal({
      ...REFUSAL,
      contentType: "text/event-stream",
      status: 200,
    });

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("text/event-stream");
  });

  test("fails a stream answer regardless of charset parameters", () => {
    const result = evaluateStreamRefusal({
      ...REFUSAL,
      contentType: "text/event-stream; charset=utf-8",
      status: 200,
    });

    expect(result.status).toBe("failed");
  });

  test("passes only on the 405 that keeps clients on request/response", () => {
    expect(evaluateStreamRefusal(REFUSAL).status).toBe("passed");
    expect(evaluateStreamRefusal({ ...REFUSAL, status: 200 }).status).toBe(
      "failed",
    );
  });

  test("fails a 405 that never says what the endpoint does serve", () => {
    // A refusal without Allow leaves the client guessing which method to use.
    expect(evaluateStreamRefusal({ ...REFUSAL, allow: null }).status).toBe(
      "failed",
    );
    expect(
      evaluateStreamRefusal({ ...REFUSAL, allow: "OPTIONS, GET, POST, DELETE" })
        .status,
    ).toBe("failed");
  });

  test("accepts any ordering and spacing of the advertised methods", () => {
    // Order is the server's business; the method set is the contract.
    expect(
      evaluateStreamRefusal({ ...REFUSAL, allow: "post ,  OPTIONS" }).status,
    ).toBe("passed");
  });

  test("fails a 405 that still advertises a session operation", () => {
    // DELETE is a session operation too, so advertising it would promise a
    // session this endpoint does not have.
    expect(
      evaluateStreamRefusal({ ...REFUSAL, allow: "OPTIONS, POST, DELETE" })
        .status,
    ).toBe("failed");
  });
});

describe("evaluateInitialize", () => {
  test("fails a JSON-RPC error riding inside a 200", () => {
    const result = evaluateInitialize({
      body: {
        error: { code: -32_000, message: "Internal error" },
        id: 1,
        jsonrpc: "2.0",
      },
      status: 200,
    });

    expect(result.status).toBe("failed");
  });

  test("fails a 200 whose result never negotiated a session", () => {
    expect(
      evaluateInitialize({ body: { jsonrpc: "2.0", result: {} }, status: 200 })
        .status,
    ).toBe("failed");
  });

  test("passes a negotiated session", () => {
    const result = evaluateInitialize({
      body: {
        jsonrpc: "2.0",
        result: {
          capabilities: {},
          protocolVersion: "2025-11-25",
          serverInfo: { name: "stella", version: "0.1.0" },
        },
      },
      status: 200,
    });

    expect(result.status).toBe("passed");
  });
});

describe("evaluateToolsList", () => {
  test("fails an empty tool list, the shape a scope regression takes", () => {
    const result = evaluateToolsList({
      body: { jsonrpc: "2.0", result: { tools: [] } },
      status: 200,
    });

    expect(result.status).toBe("failed");
  });

  test("reports how many tools the session can see", () => {
    const result = evaluateToolsList({
      body: {
        jsonrpc: "2.0",
        result: {
          tools: [{ name: "list_matters" }, { name: "search_documents" }],
        },
      },
      status: 200,
    });

    expect(result.status).toBe("passed");
    expect(result.detail).toContain("2 tools");
  });
});

describe("evaluateUnauthenticated", () => {
  test("fails a 401 that carries no authorization-server challenge", () => {
    // Without the challenge a client cannot find the authorization server, so
    // every new connector strands at sign-in while the endpoint looks up.
    const result = evaluateUnauthenticated({
      status: 401,
      wwwAuthenticate: null,
    });

    expect(result.status).toBe("failed");
  });

  test("fails when an anonymous call is answered instead of rejected", () => {
    expect(
      evaluateUnauthenticated({ status: 200, wwwAuthenticate: null }).status,
    ).toBe("failed");
  });

  test("passes a challenge-carrying rejection", () => {
    expect(
      evaluateUnauthenticated({
        status: 401,
        wwwAuthenticate:
          'Bearer resource_metadata="https://api.example/.well-known"',
      }).status,
    ).toBe("passed");
  });
});

describe("evaluateDiscovery", () => {
  test("fails a 200 that advertises no authorization server", () => {
    expect(
      evaluateDiscovery({
        body: { resource: "https://api.example/mcp" },
        status: 200,
      }).status,
    ).toBe("failed");
  });

  test("passes a well-formed metadata document", () => {
    expect(
      evaluateDiscovery({
        body: {
          authorization_servers: ["https://auth.example"],
          resource: "https://api.example/mcp",
        },
        status: 200,
      }).status,
    ).toBe("passed");
  });
});

describe("skip reporting", () => {
  test("labels every declared probe distinctly", () => {
    // Execution and the skip report both read AUTHENTICATED_PROBES, so they
    // cannot drift. What a shared list cannot prevent is two probes sharing a
    // label, which would make a skip line ambiguous about what ran.
    const names = AUTHENTICATED_PROBES.map(({ name }) => name);

    expect(new Set(names).size).toBe(names.length);
  });

  test("keeps a skipped probe out of the failure count but visible", () => {
    const summary = summarize([
      { detail: "405", name: "a", status: "passed" },
      { detail: "no token", name: "b", status: "skipped" },
      { detail: "200 text/event-stream", name: "c", status: "failed" },
    ]);

    expect(summary).toEqual({ failed: 1, skipped: 1 });
  });
});
