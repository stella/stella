import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildApiTestCommand } from "../../../scripts/api-test-command";
import { API_TEST_TIMEOUT_MS } from "../test-timeouts";
import { RESPONSE_CONFORMANCE_BATCH_DIRECTORY } from "./response-conformance-execution-collector";

const apiRoot = path.resolve(import.meta.dir, "../../..");

const runLifecycleFixture = async (source: string) => {
  const cache = path.join(apiRoot, ".cache");
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(path.join(cache, "response-conformance-"));
  const file = path.join(directory, "fixture.test.ts");
  try {
    writeFileSync(
      file,
      `${source}

test("healthy second test", () => {
  expect(1 + 1).toBe(2);
  console.log("HEALTHY SECOND BODY REACHED");
});
`,
    );
    const child = Bun.spawn({
      cmd: buildApiTestCommand({
        bunExecutable: process.execPath,
        bunRuntimeArguments: ["--no-env-file"],
        testArguments: [
          "--preload",
          path.join(apiRoot, "src/tests/setup-env.ts"),
        ],
        testFiles: [file],
        timingsDirectory: path.join(directory, "timings"),
      }),
      cwd: apiRoot,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            key !== "CLAUDECODE" &&
            key !== "AGENT" &&
            key !== RESPONSE_CONFORMANCE_BATCH_DIRECTORY,
        ),
      ),
      stdout: "pipe",
      stderr: "pipe",
      timeout: API_TEST_TIMEOUT_MS - 1000,
      killSignal: "SIGKILL",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, output: stdout + stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const childImports = `
import { expect, test } from "bun:test";
import { Result } from "better-result";
import { Elysia, t } from "elysia";
`;

const mcpFixture = `${childImports}
import * as v from "valibot";
import { createMcpRoute } from "@/api/handlers/mcp/routes-core";
import { toSafeId } from "@/api/lib/branded-types";
import { createMcpHttpRequestHandler } from "@/api/mcp/server-core";
import type { McpRequestContext } from "@/api/mcp/context";
import { serializeToolResult } from "@/api/mcp/tool-utils";
import { defineMcpToolOutput, defineValibotMcpTool } from "@/api/mcp/valibot-tool-definition";
import { createTestHandlerContext, NO_AUDIT, NO_DB } from "@/api/tests/helpers/handler-context";

const definition = defineValibotMcpTool({
  name: "conformance_fixture_tool",
  access: "read",
  readClass: "public",
  scope: "stella:read",
  description: "Conformance fixture",
  consumesServices: false,
  anonymized: { exposure: "passthrough" },
  annotations: { title: "Conformance fixture", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  inputSchema: v.strictObject({}),
});
const output = defineMcpToolOutput(v.strictObject({ count: v.number() }));
const context = createTestHandlerContext<McpRequestContext>({
  audit: NO_AUDIT,
  safeDb: NO_DB,
  scopedDb: NO_DB,
  organizationId: toSafeId<"organization">("org_fixture"),
  userId: toSafeId<"user">("user_fixture"),
  userEmail: "fixture@example.test",
  grantedScopes: ["stella:read"],
  accessibleWorkspaceIds: [],
  accessibleWorkspaceIdSet: new Set(),
  accessibleWorkspaceStatusById: new Map(),
});
const transport = createMcpHttpRequestHandler({
  actionSizePolicy: () => Result.ok(undefined),
  admitAction: async ({ run }) => Result.ok(await run()),
  authenticateMcpRequest: async () => Result.ok({ organizationId: "org_fixture", userId: "user_fixture", scopes: ["stella:read"] }),
  captureError: () => undefined,
  getMcpToolDefinition: async () => definition,
  getMcpToolRequiredScopesHint: () => ["stella:read"],
  handleMcpToolCall: async () => serializeToolResult({ status: "success", data: { count: "wrong" } }, output, definition.name),
  listMcpTools: async () => [],
  listMcpResources: () => [],
  readMcpResource: () => ({ contents: [] }),
  recordMcpSessionInitialized: () => undefined,
  resolveMcpSessionContext: async () => context,
});

test("malformed tool output crosses the real MCP HTTP transport", async () => {
  const app = new Elysia({ aot: false }).use(createMcpRoute({ handleMcpHttpRequest: transport }));
  const response = await app.handle(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { authorization: "Bearer fixture", accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: definition.name, arguments: {} } }),
  }));
  const body: unknown = await response.json();
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
  expect(body).toMatchObject({ jsonrpc: "2.0", id: 1 });
  const error = isRecord(body) ? body["error"] : undefined;
  const result = isRecord(body) ? body["result"] : undefined;
  expect((isRecord(error) && typeof error["code"] === "number" && typeof error["message"] === "string") ||
    (isRecord(result) && result["isError"] === true && Array.isArray(result["content"]))).toBe(true);
  console.log("MCP BODY REACHED");
});
`;

const handlerFixture = `${childImports}
import { ACCOUNT_ACCESS, createSafePublicHandler } from "@/api/lib/api-handlers";

const endpoint = createSafePublicHandler({
  contract: "patch",
  cache: { kind: "public", maxAge: 0 },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "health_infra" },
  response: t.Object({ count: t.Number() }),
}, async function* () { return Result.ok({ count: "wrong" }); });

test("a caught factory defect cannot pass the test", async () => {
  let converted = false;
  const app = new Elysia({ aot: false })
    .onError(() => { converted = true; return new Response("converted"); })
    .get("/caught-handler", async (context) => await Reflect.apply(endpoint.handler, undefined, [context]));
  await Result.tryPromise(async () => await app.handle(new Request("http://localhost/caught-handler")));
  expect(converted).toBe(true);
  console.log("HANDLER BODY REACHED");
});
`;

const capturedFixture = `${childImports}
import * as v from "valibot";
import { serializeToolResult } from "@/api/mcp/tool-utils";
import { defineMcpToolOutput } from "@/api/mcp/valibot-tool-definition";
import { captureResponseConformanceViolations } from "@/api/tests/helpers/response-conformance-sink";

test("an explicit expected-violation capture is isolated from teardown", async () => {
  const output = defineMcpToolOutput(v.strictObject({ count: v.number() }));
  const captured = await captureResponseConformanceViolations(async () => Result.try(() =>
    serializeToolResult({ status: "success", data: { count: "wrong" } }, output, "captured_fixture_tool")));
  expect(captured.violations).toHaveLength(1);
  expect(captured.violations.at(0)).toMatchObject({ route: "MCP captured_fixture_tool" });
  console.log("CAPTURE BODY REACHED");
});
`;

test("MCP output violations fail teardown even after transport conversion", async () => {
  const child = await runLifecycleFixture(mcpFixture);
  expect(child.output).toContain("MCP BODY REACHED");
  expect(child.output).toContain("HEALTHY SECOND BODY REACHED");
  expect(child.output).toContain("(pass) healthy second test");
  expect(child.exitCode, child.output).toBe(1);
  expect(child.output).toContain("MCP conformance_fixture_tool");
});

test("caught handler violations fail teardown without leaking into the next test", async () => {
  const child = await runLifecycleFixture(handlerFixture);
  expect(child.output).toContain("HANDLER BODY REACHED");
  expect(child.output).toContain("HEALTHY SECOND BODY REACHED");
  expect(child.output).toContain("(pass) healthy second test");
  expect(child.exitCode, child.output).toBe(1);
  expect(child.output).toContain("/caught-handler");
});

test("explicit captures keep expected violations out of test teardown", async () => {
  const child = await runLifecycleFixture(capturedFixture);
  expect(child.output).toContain("CAPTURE BODY REACHED");
  expect(child.output).toContain("HEALTHY SECOND BODY REACHED");
  expect(child.exitCode, child.output).toBe(0);
});
