import { toolDefinition } from "@tanstack/ai";
import { createMCPClientFromTransport } from "@tanstack/ai-mcp";
import type { Transport } from "@tanstack/ai-mcp";
import { expect, spyOn, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

const CALL_TIMEOUT_MS = 5 * 60_000;
const TOOL_NAME = "slow_tool";

type FakeServerOptions = {
  era: "legacy" | "modern";
  execution: "plain" | "task" | "input" | "abort-task";
};

const createFakeServer = ({ era, execution }: FakeServerOptions) => {
  const methods: string[] = [];
  const calls: unknown[] = [];
  const controller = new AbortController();
  const capabilities = {
    tools: {},
    ...(execution === "task" || execution === "abort-task"
      ? { tasks: { requests: { tools: { call: {} } } } }
      : {}),
  };
  const taskFields = {
    taskId: "task-1",
    ttl: null,
    createdAt: "2026-10-07T12:00:00Z",
    lastUpdatedAt: "2026-10-07T12:00:00Z",
  };
  const transport: Transport = {
    close: async () => transport.onclose?.(),
    start: async () => undefined,
    send: async (message) => {
      if (!("method" in message) || !("id" in message)) {
        return;
      }
      methods.push(message.method);
      const reply = (result: Record<string, unknown>) => {
        transport.onmessage?.({
          id: message.id,
          jsonrpc: "2.0",
          result:
            era === "modern" ? { resultType: "complete", ...result } : result,
        });
      };
      switch (message.method) {
        case "server/discover":
          reply({
            capabilities,
            supportedVersions: era === "modern" ? ["2026-07-28"] : [],
          });
          return;
        case "initialize":
          reply({
            capabilities,
            protocolVersion: "2025-11-25",
            serverInfo: { name: "timeout-test", version: "1.0.0" },
          });
          return;
        case "tools/list":
          reply({
            tools: [
              {
                inputSchema: { properties: {}, type: "object" },
                name: TOOL_NAME,
                ...(execution === "task" || execution === "abort-task"
                  ? { execution: { taskSupport: "required" } }
                  : {}),
              },
            ],
          });
          return;
        case "tools/call":
          calls.push(message.params);
          if (execution === "task" || execution === "abort-task") {
            reply({
              task: { ...taskFields, status: "working", pollInterval: 0 },
            });
            return;
          }
          if (execution === "input" && calls.length === 1) {
            reply({
              resultType: "input_required",
              inputRequests: {
                answer: {
                  method: "elicitation/create",
                  params: {
                    message: "Confirm",
                    requestedSchema: { type: "object", properties: {} },
                  },
                },
              },
              requestState: "state-1",
            });
            return;
          }
          reply({ content: [{ text: "completed", type: "text" }] });
          return;
        case "tasks/get":
          if (execution === "abort-task") {
            controller.abort(new DOMException("Stopped task", "AbortError"));
            return;
          }
          reply({ ...taskFields, status: "completed" });
          return;
        case "tasks/result":
          reply({ content: [{ text: "completed", type: "text" }] });
          return;
        case "tasks/cancel":
          reply({ ...taskFields, status: "cancelled" });
          return;
        default:
          throw new TypeError(`Unexpected MCP request: ${message.method}`);
      }
    },
  };
  return { calls, controller, methods, transport };
};

const cases = [
  { era: "legacy", execution: "plain" },
  { era: "modern", execution: "plain" },
  { era: "legacy", execution: "task" },
  { era: "modern", execution: "input" },
] as const satisfies readonly FakeServerOptions[];

for (const scenario of cases) {
  for (const binding of ["definition", "discovery"] as const) {
    test(`a tool timeout covers ${scenario.era} ${scenario.execution} requests through ${binding}`, async () => {
      const server = createFakeServer(scenario);
      const client = await createMCPClientFromTransport(server.transport);
      const options = { callToolTimeoutMs: CALL_TIMEOUT_MS };
      const definitions = [
        toolDefinition({
          description: "Wait before returning a result",
          inputSchema: { properties: {}, type: "object" },
          name: TOOL_NAME,
        }),
      ];
      const tools =
        binding === "definition"
          ? await client.tools(definitions, options)
          : await client.tools(options);
      const tool = tools.at(0);
      if (!tool?.execute) {
        throw new TypeError("The MCP client did not bind an executable tool");
      }
      const firstRequest = server.methods.length;
      const timer = spyOn(globalThis, "setTimeout");
      try {
        expect(
          await tool.execute(
            {},
            {
              abortSignal: server.controller.signal,
              ...(scenario.execution === "input"
                ? {
                    inputResponse: {
                      status: "resolved",
                      payload: { accepted: true },
                    },
                  }
                : {}),
            },
          ),
        ).toBe("completed");
        const requests = server.methods.slice(firstRequest);
        let expectedRequests = ["tools/call"];
        switch (scenario.execution) {
          case "task":
            expectedRequests = ["tools/call", "tasks/get", "tasks/result"];
            break;
          case "input":
            expectedRequests = ["tools/call", "tools/call"];
            break;
          case "plain":
            break;
          default:
            scenario.execution satisfies never;
        }
        expect(requests).toEqual(expectedRequests);
        expect(timer.mock.calls.map(([, timeout]) => timeout)).toEqual(
          requests.map(() => CALL_TIMEOUT_MS),
        );
        if (scenario.execution === "input") {
          expect(server.calls.at(1)).toMatchObject({
            requestState: "state-1",
            inputResponses: {
              answer: { action: "accept", content: { accepted: true } },
            },
          });
        }
      } finally {
        timer.mockRestore();
        await client.close();
      }
    });
  }
}

test("aborting a task preserves cancellation and its configured request timeout", async () => {
  const server = createFakeServer({ era: "legacy", execution: "abort-task" });
  const client = await createMCPClientFromTransport(server.transport);
  const tools = await client.tools({ callToolTimeoutMs: CALL_TIMEOUT_MS });
  const tool = tools.at(0);
  if (!tool?.execute) {
    throw new TypeError("The MCP client did not bind an executable tool");
  }
  const firstRequest = server.methods.length;
  const timer = spyOn(globalThis, "setTimeout");
  try {
    const error = await rejectionOf(
      tool.execute({}, { abortSignal: server.controller.signal }),
    );
    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({ message: "Stopped task" });
    expect(server.methods.slice(firstRequest)).toEqual([
      "tools/call",
      "tasks/get",
      "tasks/cancel",
    ]);
    expect(timer.mock.calls.map(([, timeout]) => timeout)).toEqual([
      CALL_TIMEOUT_MS,
      CALL_TIMEOUT_MS,
      CALL_TIMEOUT_MS,
    ]);
  } finally {
    timer.mockRestore();
    await client.close();
  }
});
