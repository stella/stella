import { describe, expect, test } from "bun:test";

import { CASE_LAW_RESULTS_APP, DECISION_READER_APP } from "../manifest";
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
  test("arguments the server refuses fail as invalid arguments naming each nested field", async () => {
    const sent: unknown[] = [];
    const bridge = createPresentationBridge({
      manifest: DECISION_READER_APP,
      parse: () => ({}),
      host: {
        callServerTool: async (request) => {
          sent.push(request);
          return {
            content: [],
            isError: true,
            structuredContent: {
              error: {
                code: "validation_error",
                message: "Invalid input",
                requestId: "receipt-provision",
                retryable: false,
                issues: [
                  { path: "provision.anchor", message: "Required" },
                  { path: "provision.extra", message: "Unknown key" },
                ],
              },
            },
          };
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
    const request = {
      name: "preview_cited_provision",
      arguments: {
        provision: {
          document_id: "00000000-0000-4000-8000-000000000001",
          extra: true,
        },
      },
    } as const;
    await bridge.call(request);
    expect(sent).toEqual([request]);
    const result = bridge.getSnapshot().result;
    expect(result.status).toBe("error");
    if (result.status !== "error") {
      return;
    }
    expect(result.failure).toEqual({
      type: "invalid_arguments",
      requestId: "receipt-provision",
      retryable: false,
      fields: ["provision.anchor", "provision.extra"],
      toolCode: "validation_error",
    });
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

test("a filter the server refuses keeps paging on the arguments of the page still shown", async () => {
  const page = { results: ["existing decision"] };
  const calls: unknown[] = [];
  const bridge = createPresentationBridge({
    manifest: CASE_LAW_RESULTS_APP,
    parse: () => page,
    host: {
      callServerTool: async ({ arguments: arguments_ }) => {
        calls.push(arguments_);
        if (typeof arguments_ === "object" && "courts" in arguments_) {
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
