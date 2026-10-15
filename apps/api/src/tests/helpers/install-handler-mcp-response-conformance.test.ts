import { Result } from "better-result";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { status, t } from "elysia";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  ResponseConformanceError,
  rethrowResponseConformanceError,
} from "@/api/lib/response-conformance-error";
import { observeHandlerResponses } from "@/api/lib/response-conformance-observer";
import { observeMcpResponseConformance } from "@/api/mcp/response-conformance-observer";

import { installHandlerMcpResponseConformance } from "./install-handler-mcp-response-conformance";
import {
  rethrowResponseConformanceFailure,
  setResponseConformanceRequestModels,
} from "./response-conformance-request-errors";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("installed handler and MCP conformance observers", () => {
  test("leaves unconstrained streaming handler responses readable without cloning", async () => {
    restore = installHandlerMcpResponseConformance();
    const chunks = ["first", "second", "last"];
    let nextChunk = 0;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          const chunk = chunks.at(nextChunk++);
          if (chunk === undefined) {
            controller.close();
            return;
          }
          controller.enqueue(new TextEncoder().encode(chunk));
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const clone = spyOn(response, "clone");
    const handler = observeHandlerResponses(async () => response, {
      response: t.Any(),
    });
    try {
      expect(await handler()).toBe(response);
      expect(clone).not.toHaveBeenCalled();
      expect(await response.text()).toBe(chunks.join(""));
      expect(nextChunk).toBe(chunks.length + 1);
    } finally {
      clone.mockRestore();
    }
  });

  test("validates direct handlers after JSON wire serialization", async () => {
    restore = installHandlerMcpResponseConformance();
    const handler = observeHandlerResponses(
      async () => ({
        timestamp: new Date("2026-01-01T00:00:00.000Z"),
        omitted: undefined,
      }),
      {
        response: t.Object(
          { timestamp: t.String() },
          { additionalProperties: false },
        ),
      },
    );
    const result = await handler();
    expect(result.timestamp).toBeInstanceOf(Date);
    expect(Object.hasOwn(result, "omitted")).toBe(true);
  });

  test("preserves conformance failures through Result and request error conversion", async () => {
    restore = installHandlerMcpResponseConformance();
    const request = new Request("http://localhost/fixture");
    const handler = observeHandlerResponses(async () => ({ count: "wrong" }), {
      response: t.Object({ count: t.Number() }),
    });
    const observed = await Result.tryPromise(
      async () =>
        await Reflect.apply(handler, undefined, [
          { request, route: "/fixture" },
        ]),
    );
    expect(Result.isError(observed)).toBe(true);
    if (Result.isError(observed)) {
      expect(() => rethrowResponseConformanceError(observed.error)).toThrow(
        ResponseConformanceError,
      );
    }
    expect(() => rethrowResponseConformanceFailure(request)).toThrow(
      ResponseConformanceError,
    );
  });

  test("validates status wrappers from direct handlers", async () => {
    restore = installHandlerMcpResponseConformance();
    const handler = observeHandlerResponses(
      async () => status(201, { count: 1 }),
      {
        response: { 200: t.Object({ count: t.Number() }) },
      },
    );
    expect(await rejectionOf(handler())).toMatchObject({
      status: 201,
      issuePath: "(status)",
    });
  });

  test("validates statuses without requiring protocol-forbidden handler bodies", async () => {
    restore = installHandlerMcpResponseConformance();
    const head = observeHandlerResponses(async () => undefined, {
      response: t.String(),
    });
    expect(
      await Reflect.apply(head, undefined, [
        { request: new Request("http://localhost/head", { method: "HEAD" }) },
      ]),
    ).toBeUndefined();
    for (const code of [204, 304] as const) {
      const handler = observeHandlerResponses(async () => status(code), {
        response: { [code]: t.String() },
      });
      expect((await handler()).code).toBe(code);
    }
  });

  test("uses pre-request models while unresolved direct requests fail closed", async () => {
    restore = installHandlerMcpResponseConformance();
    const handler = observeHandlerResponses(async () => ({ count: 1 }), {
      response: { 200: "Output" },
    });
    const unresolved = new Request("http://localhost/unresolved");
    expect(
      await rejectionOf(
        Reflect.apply(handler, undefined, [{ request: unresolved }]),
      ),
    ).toMatchObject({ issuePath: "(schema)" });
    const resolved = new Request("http://localhost/resolved");
    setResponseConformanceRequestModels(resolved, {
      Output: t.Object({ count: t.Number() }),
    });
    expect(
      await Reflect.apply(handler, undefined, [{ request: resolved }]),
    ).toEqual({ count: 1 });
  });

  test("labels MCP serialization failures as body defects", () => {
    restore = installHandlerMcpResponseConformance();
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    for (const result of [undefined, 1n, cyclic]) {
      expect(() =>
        observeMcpResponseConformance({
          toolName: "fixture",
          schema: { type: "object" },
          result,
          issuePaths: [],
        }),
      ).toThrow("at (body)");
    }
  });

  test("validates MCP wire values and fails pre-conversion issue paths", () => {
    restore = installHandlerMcpResponseConformance();
    const schema = {
      type: "object",
      properties: { timestamp: { type: "string" } },
      required: ["timestamp"],
      additionalProperties: false,
    };
    observeMcpResponseConformance({
      toolName: "fixture",
      schema,
      result: {
        timestamp: new Date("2026-01-01T00:00:00.000Z"),
        omitted: undefined,
      },
      issuePaths: [],
    });
    expect(() =>
      observeMcpResponseConformance({
        toolName: "fixture",
        schema,
        result: {},
        issuePaths: [],
      }),
    ).toThrow(ResponseConformanceError);
    expect(() =>
      observeMcpResponseConformance({
        toolName: "fixture",
        schema,
        result: { timestamp: "valid" },
        issuePaths: ["undeclared"],
      }),
    ).toThrow("at undeclared");
  });
});
