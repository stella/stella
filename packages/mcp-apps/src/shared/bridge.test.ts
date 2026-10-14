import { describe, expect, test } from "bun:test";

import { searchFilterInput } from "../case-law-results/model";
import { CASE_LAW_RESULTS_APP, STATUTE_TIMELINE_APP } from "../manifest";
import {
  appFailure,
  formatAppFailure,
  LocalizedAppError,
  parseAppFailure,
  toolAppFailure,
} from "./app-error";
import {
  parseAppToolPayload,
  requestPresentationTool,
  createPresentationBridge,
} from "./bridge";
import { appLocale } from "./locale";

describe("MCP app tool payloads", () => {
  test("structured content takes precedence over text", () => {
    const payload = { result: { id: "123" } };
    expect(
      parseAppToolPayload({
        structuredContent: payload,
        content: [{ type: "text", text: '{"result":null}' }],
      }),
    ).toBe(payload);
  });

  test("text-only replies parse JSON and absent or malformed payloads stay absent", () => {
    expect(
      parseAppToolPayload({
        content: [{ type: "text", text: '{"result":123}' }],
      }),
    ).toEqual({ result: 123 });
    expect(parseAppToolPayload({ content: [] })).toBeUndefined();
    expect(
      parseAppToolPayload({
        content: [{ type: "text", text: "invalid JSON" }],
      }),
    ).toBeUndefined();
  });
});

describe("embedded app tool-call boundary", () => {
  test("invalid declared arguments are refused before the host bridge is called", async () => {
    let calls = 0;
    const result = await requestPresentationTool({
      manifest: CASE_LAW_RESULTS_APP,
      request: {
        name: "search_case_law",
        arguments: { queries: ["dismissal"], country: "CZE", limit: "many" },
      },
      app: {
        callServerTool: async () => {
          calls += 1;
          return { content: [] };
        },
      },
    });
    expect(calls).toBe(0);
    expect(result.status).toBe("error");
    if (result.status !== "error") {
      return;
    }
    expect(result.failure.type).toBe("invalid_arguments");
    expect(result.failure.fields).toContain("limit");
    expect(result.failure.retryable).toBe(false);
    expect(result.failure.requestId).not.toBe("");
  });

  test("multi-court searches reach the host with only declared arguments", async () => {
    let sent: unknown;
    const result = await requestPresentationTool({
      manifest: CASE_LAW_RESULTS_APP,
      request: {
        name: "search_case_law",
        arguments: {
          queries: ["dismissal"],
          country: "CZE",
          courts: ["Nejvyšší soud", "Ústavní soud"],
          source_id: "00000000-0000-4000-8000-000000000001",
          arbitrary: true,
        },
      },
      app: {
        callServerTool: async (request) => {
          sent = request;
          return { content: [] };
        },
      },
    });
    expect(result.status).toBe("ready");
    expect(sent).toEqual({
      name: "search_case_law",
      arguments: {
        queries: ["dismissal"],
        country: "CZE",
        courts: ["Nejvyšší soud", "Ústavní soud"],
        source_id: "00000000-0000-4000-8000-000000000001",
      },
    });
  });

  test("tool refusals expose localized reasons and receipts without model instructions", () => {
    const failure = toolAppFailure(
      {
        error: {
          code: "permission_denied",
          message: "Pass token: true",
          hint: "MODEL_ONLY",
          requestId: "receipt-123",
          retryable: false,
        },
      },
      "local",
    );
    for (const locale of ["en", "cs", "ar"]) {
      const message = formatAppFailure(failure, appLocale(locale).t);
      expect(message).toContain("receipt-123");
      expect(message).not.toContain("MODEL_ONLY");
      expect(message).not.toContain("token");
    }
    expect(failure.type).toBe("permission_denied");
    expect(failure.retryable).toBe(false);
  });
});

test("typed bridge failure roundtrips without losing validation fields", () => {
  const failure = {
    ...appFailure("invalid_arguments", "receipt-123"),
    fields: ["queries"],
    toolCode: "validation_error",
  };
  const payload = { appFailure: failure };
  expect(parseAppFailure(payload)).toEqual(failure);
  expect(toolAppFailure(payload, "fallback")).toEqual(failure);
});

test("Retry repeats the failed new court selection rather than the earlier successful search", async () => {
  const sent: unknown[] = [];
  let failNext = false;
  const bridge = createPresentationBridge({
    manifest: CASE_LAW_RESULTS_APP,
    parse: () => ({ results: [] }),
    host: {
      callServerTool: async (request) => {
        sent.push(request);
        if (failNext) {
          failNext = false;
          throw new LocalizedAppError({ key: "bridgeUnavailable" });
        }
        return { content: [], structuredContent: {} };
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      getHostContext: () => ({}),
      getHostCapabilities: () => undefined,
      connect: async () => {},
      openLink: async () => ({}),
      requestDisplayMode: async () => ({ mode: "inline" }),
      onteardown: undefined,
    },
  });
  await bridge.call({
    name: "search_case_law",
    arguments: { queries: ["dismissal"], country: "CZE" },
  });
  failNext = true;
  const changed = {
    name: "search_case_law",
    arguments: {
      queries: ["dismissal"],
      country: "CZE",
      courts: ["Nejvyšší soud", "Ústavní soud"],
    },
  } as const;
  await bridge.call(changed);
  expect(bridge.getSnapshot().result.status).toBe("error");
  await bridge.retry();
  expect(sent.at(-1)).toEqual(changed);
  expect(sent.at(-2)).toEqual(changed);
  expect(bridge.getSnapshot().result.status).toBe("ready");
});

describe("presentation actions normalize raw model input before transport", () => {
  const input = {
    queries: ["dismissal"],
    country: "CZE",
    limit: 50,
    date_from: "2024",
    courts: "X",
    category: "",
  };
  test.each([
    { action: "search", arguments: input },
    {
      action: "next page",
      arguments: { ...input, cursor: "next-fixture-page" },
    },
    {
      action: "filter submit",
      arguments: searchFilterInput({
        input,
        country: "CZE",
        court: { type: "courts", names: ["X"] },
        from: "2024",
        to: "",
      }),
    },
  ])(
    "$action reaches the host with repaired dates, lists and the declared page size",
    async ({ arguments: arguments_ }) => {
      const sent: unknown[] = [];
      const result = await requestPresentationTool({
        manifest: CASE_LAW_RESULTS_APP,
        request: { name: "search_case_law", arguments: arguments_ },
        app: {
          callServerTool: async (request) => {
            sent.push(request.arguments);
            return { content: [] };
          },
        },
      });
      expect(result.status).toBe("ready");
      expect(sent).toHaveLength(1);
      expect(sent.at(0)).toMatchObject({
        limit: 20,
        date_from: "2024-01-01",
        courts: ["X"],
      });
      expect(sent.at(0)).not.toHaveProperty("category");
    },
  );
  test("timeline load-more normalizes a repaired model page size and retains its cursor", async () => {
    let sent: unknown;
    const result = await requestPresentationTool({
      manifest: STATUTE_TIMELINE_APP,
      request: {
        name: "read_provision_history",
        arguments: {
          eli: "89/2012 Sb.",
          limit: 50,
          cursor: "next-timeline-page",
          anchor: "par_1",
        },
      },
      app: {
        callServerTool: async (request) => {
          sent = request.arguments;
          return { content: [] };
        },
      },
    });
    expect(result.status).toBe("ready");
    expect(sent).toEqual({
      eli: "https://www.e-sbirka.cz/eli/cz/sb/2012/89",
      limit: 20,
      cursor: "next-timeline-page",
      anchor: "par_1",
    });
  });
});

test("a filter the server refuses keeps paging on the arguments of the page still shown", async () => {
  const page = { results: ["existing decision"] };
  const calls: unknown[] = [];
  const bridge = createPresentationBridge({
    manifest: CASE_LAW_RESULTS_APP,
    parse: () => page,
    host: {
      callServerTool: async ({ arguments: arguments_ }) => {
        calls.push(arguments_);
        if (
          typeof arguments_ === "object" &&
          arguments_ !== null &&
          "courts" in arguments_
        ) {
          return {
            content: [],
            isError: true,
            structuredContent: {
              appFailure: {
                ...appFailure("invalid_arguments", "receipt-court"),
                fields: ["courts"],
                toolCode: "validation_error",
              },
            },
          };
        }
        return { content: [], structuredContent: {} };
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      getHostContext: () => ({}),
      getHostCapabilities: () => undefined,
      connect: async () => {},
      openLink: async () => ({}),
      requestDisplayMode: async () => ({ mode: "inline" }),
      onteardown: undefined,
    },
  });
  await bridge.call({
    name: "search_case_law",
    arguments: { queries: ["dismissal"], country: "CZE" },
  });
  await bridge.call({
    name: "search_case_law",
    arguments: { queries: ["dismissal"], country: "CZE", courts: ["X"] },
  });
  const refused = bridge.getSnapshot().result;
  expect(refused.status).toBe("error");
  if (refused.status !== "error") {
    return;
  }
  expect(refused.failure.type).toBe("invalid_arguments");
  expect(refused.previous).toEqual({ status: "ready", view: page });
  expect(bridge.getSnapshot().input).toEqual({
    queries: ["dismissal"],
    country: "CZE",
  });

  await bridge.call({
    name: "search_case_law",
    arguments: { ...bridge.getSnapshot().input, cursor: "existing-page-next" },
  });
  expect(calls.at(-1)).toEqual({
    queries: ["dismissal"],
    country: "CZE",
    cursor: "existing-page-next",
  });
  expect(bridge.getSnapshot().result.status).toBe("ready");
});

test("a locally refused filter preserves its page input and leaves Next working without entering loading", async () => {
  const page = { results: ["existing decision"] };
  const states: string[] = [];
  const calls: unknown[] = [];
  const bridge = createPresentationBridge({
    manifest: CASE_LAW_RESULTS_APP,
    parse: () => page,
    host: {
      callServerTool: async ({ arguments: arguments_ }) => {
        calls.push(arguments_);
        return { content: [], structuredContent: {} };
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      getHostContext: () => ({}),
      getHostCapabilities: () => undefined,
      connect: async () => {},
      openLink: async () => ({}),
      requestDisplayMode: async () => ({ mode: "inline" }),
      onteardown: undefined,
    },
  });
  await bridge.call({
    name: "search_case_law",
    arguments: { queries: ["dismissal"], country: "CZE" },
  });
  const previousInput = bridge.getSnapshot().input;
  const previousTool = bridge.getSnapshot().tool;
  bridge.subscribe(() => {
    states.push(bridge.getSnapshot().result.status);
  });
  await bridge.call({
    name: "search_case_law",
    arguments: { queries: ["x".repeat(501)], country: "CZE" },
  });
  expect(calls).toHaveLength(1);
  expect(states).toEqual(["error"]);
  expect(bridge.getSnapshot().input).toBe(previousInput);
  expect(bridge.getSnapshot().tool).toBe(previousTool);
  const result = bridge.getSnapshot().result;
  expect(result.status).toBe("error");
  if (result.status !== "error") {
    return;
  }
  expect(result.previous).toEqual({ status: "ready", view: page });
  expect(result.failure.type).toBe("invalid_arguments");
  await bridge.call({
    name: "search_case_law",
    arguments: { ...bridge.getSnapshot().input, cursor: "existing-page-next" },
  });
  expect(calls).toEqual([
    { queries: ["dismissal"], country: "CZE" },
    { queries: ["dismissal"], country: "CZE", cursor: "existing-page-next" },
  ]);
  expect(bridge.getSnapshot().result.status).toBe("ready");
});
