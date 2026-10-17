import { expect, test } from "bun:test";

import { collectConformanceTestEvidence } from "./conformance-test-evidence";

const inspect = (source: string) =>
  collectConformanceTestEvidence([
    { file: "apps/api/src/tests/sample.test.ts", source },
  ]);

test("imports, comments, strings and type references are not invocation evidence", () => {
  expect(
    inspect(`
    import endpoint from "@/api/handlers/desktop-presence/read";
    import { handleMcpToolCall } from "@/api/mcp/tools";
    type Handler = typeof endpoint.handler;
    // endpoint.handler(context); fetch("http://localhost/v1/fiction");
    const prose = 'handleMcpToolCall({toolName:"fiction"})';
  `),
  ).toEqual({
    handlerCalls: [],
    httpCalls: [],
    mcpCalls: [],
    unresolvedCalls: { handler: 0, http: 0, mcp: 0 },
  });
});

test("actual imported handler calls resolve aliases, named exports and literal property access", () => {
  expect(
    inspect(`
    import renamed from "@/api/handlers/desktop-presence/read";
    import { list as another } from "../handlers/items/read.js";
    renamed.handler(context);
    renamed["handler"](context);
    another.handler(context);
  `).handlerCalls,
  ).toEqual([
    {
      endpoint: "apps/api/src/handlers/desktop-presence/read.ts",
      tests: ["apps/api/src/tests/sample.test.ts"],
    },
    {
      endpoint: "apps/api/src/handlers/items/read.ts#list",
      tests: ["apps/api/src/tests/sample.test.ts"],
    },
  ]);
});

test("handler observations remain separate from literal HTTP invocation evidence", () => {
  const result = inspect(`
    import api from "@/api/server";
    import endpoint from "@/api/handlers/desktop-presence/read";
    endpoint.handler(context);
    api.handle(new Request("http://localhost/v1/items/123?expand=true", {method: "post"}));
    fetch(\`http://localhost/v1/items\`);
    api.handle(new Request(dynamic));
    fetch("/relative");
    api.handle(new Request("http://localhost/v1/items", {...options}));
  `);
  expect(result.httpCalls).toEqual([
    {
      source: "composed-api",
      method: "POST",
      path: "/v1/items/123",
      tests: ["apps/api/src/tests/sample.test.ts"],
    },
    {
      source: "fetch",
      method: "GET",
      path: "/v1/items",
      tests: ["apps/api/src/tests/sample.test.ts"],
    },
  ]);
  expect(result.handlerCalls).toHaveLength(1);
  expect(result.unresolvedCalls.http).toBe(3);
});

test("recognizes direct Elysia instances and rejects unrelated handle methods", () => {
  const result = inspect(`
    import { Elysia as Server } from "elysia";
    const app = new Server();
    app.handle(new Request("http://localhost/fixture"));
    unrelated.handle(new Request("http://localhost/not-evidence"));
  `);
  expect(result.httpCalls).toEqual([
    {
      source: "standalone-app",
      method: "GET",
      path: "/fixture",
      tests: ["apps/api/src/tests/sample.test.ts"],
    },
  ]);
  expect(result.unresolvedCalls.http).toBe(1);
});

test("only imported MCP dispatch calls with statically known names and modes count", () => {
  const result = inspect(`
    import { handleMcpToolCall as dispatch } from "@/api/mcp/tools";
    dispatch({toolName: "search"});
    dispatch({toolName: "read", mode: "full"});
    dispatch({toolName: dynamic});
    dispatch({...args, toolName: "uncertain"});
    handleMcpToolCall({toolName: "ordinaryFunction"});
  `);
  expect(result.mcpCalls).toEqual([
    {
      mode: "default",
      name: "search",
      tests: ["apps/api/src/tests/sample.test.ts"],
    },
    {
      mode: "full",
      name: "read",
      tests: ["apps/api/src/tests/sample.test.ts"],
    },
  ]);
  expect(result.unresolvedCalls.mcp).toBe(2);
});

test("ambiguous shadowed names fail closed instead of crediting imported bindings", () => {
  const result = inspect(`
    import endpoint from "@/api/handlers/desktop-presence/read";
    import { handleMcpToolCall as dispatch } from "@/api/mcp/tools";
    function fixture(endpoint, dispatch, fetch) {
      endpoint.handler(context);
      dispatch({toolName: "fiction"});
      fetch("http://localhost/fiction");
    }
  `);
  expect(result.handlerCalls).toEqual([]);
  expect(result.httpCalls).toEqual([]);
  expect(result.mcpCalls).toEqual([]);
  expect(result.unresolvedCalls).toEqual({ handler: 1, http: 1, mcp: 1 });
});

test("evidence is deduplicated and deterministic across file ordering", () => {
  const source =
    'fetch("http://localhost/v1/items"); fetch("http://localhost/v1/items");';
  const sources = [
    { file: "b.test.ts", source },
    { file: "a.test.ts", source },
  ];
  const result = collectConformanceTestEvidence(sources);
  expect(result).toEqual(collectConformanceTestEvidence(sources.toReversed()));
  expect(result.httpCalls).toEqual([
    {
      source: "fetch",
      method: "GET",
      path: "/v1/items",
      tests: ["a.test.ts", "b.test.ts"],
    },
  ]);
});

test("identical HTTP paths retain distinct targets so only composed requests credit the API registry", () => {
  const result = inspect(`
    import api from "@/api/server";
    import Elysia from "elysia";
    const fixture = new Elysia();
    api.handle(new Request("http://localhost/shared"));
    fixture.handle(new Request("http://localhost/shared"));
    fetch("http://localhost/shared");
  `);
  expect(result.httpCalls).toEqual([
    {
      source: "composed-api",
      method: "GET",
      path: "/shared",
      tests: ["apps/api/src/tests/sample.test.ts"],
    },
    {
      source: "fetch",
      method: "GET",
      path: "/shared",
      tests: ["apps/api/src/tests/sample.test.ts"],
    },
    {
      source: "standalone-app",
      method: "GET",
      path: "/shared",
      tests: ["apps/api/src/tests/sample.test.ts"],
    },
  ]);
  expect(result.unresolvedCalls.http).toBe(0);
});
