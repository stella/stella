import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { VISUAL_PREVIEW_TOOL_NAME } from "@stll/api-contract/visual-preview";
import type { VisualPreviewOutput } from "@stll/api-contract/visual-preview";
import type { FailureGrade, FailureReason } from "@stll/errors";
import { rejectionOf } from "@stll/property-testing/rejection";

import { VISUAL_SHOWCASE_GUIDANCE } from "@/api/handlers/chat/tools/visual-showcase-guidance";
import { createVisualResourceOrigin } from "@/api/handlers/visual-sandbox/resource-origin";
import { createSafeId } from "@/api/lib/branded-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { resetFailureObservationsForTesting } from "@/api/lib/observability/failure-shadow";
import { VisualPreviewError } from "@/api/lib/visual-preview";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

import { createShowVisualTools } from "./show-visual-tools";

const unavailablePreview = async () =>
  Result.err(
    new VisualPreviewError({
      code: "not-configured",
      message: "Preview is not configured",
    }),
  );

const previewFailures = {
  unavailable: {
    error: new VisualPreviewError({
      code: "unavailable",
      message: "Synthetic unavailable preview",
    }),
    grade: "defect",
    reason: "visual_preview_unavailable",
  },
  "not-configured": {
    error: new VisualPreviewError({
      code: "not-configured",
      message: "Synthetic preview without configuration",
    }),
    grade: "anticipated",
    reason: "visual_preview_not_configured",
  },
  timeout: {
    error: new VisualPreviewError({
      code: "timeout",
      message: "Synthetic preview timeout",
    }),
    grade: "defect",
    reason: "visual_preview_timeout",
  },
  "invalid-input": {
    error: new VisualPreviewError({
      code: "invalid-input",
      message: "Synthetic invalid preview input",
    }),
    grade: "anticipated",
    reason: "visual_preview_input_invalid",
  },
  "invalid-response": {
    error: new VisualPreviewError({
      code: "invalid-response",
      message: "Synthetic invalid preview response",
    }),
    grade: "defect",
    reason: "visual_preview_response_invalid",
  },
} as const satisfies Record<
  VisualPreviewError["code"],
  { error: VisualPreviewError; grade: FailureGrade; reason: FailureReason }
>;

let logs: RecordingLogger;
let analytics: RecordingAnalytics;

beforeEach(() => {
  logs = installRecordingLogger();
  analytics = installRecordingAnalytics();
  resetFailureObservationsForTesting();
});

afterEach(() => {
  logs.restore();
  analytics.restore();
  resetFailureObservationsForTesting();
});

describe("show visual", () => {
  test.each(Object.entries(previewFailures))(
    "reports a %s preview failure while keeping the published resource",
    async (code, { error: failure, grade, reason }) => {
      expect(code).toBe(failure.code);
      const origin = createVisualResourceOrigin();
      const emissions: unknown[] = [];
      const tool = createShowVisualTools({
        origin,
        store: async () =>
          Result.ok({
            fileId: createSafeId<"userFile">(),
            document: "<!doctype html><p>Revenue</p>",
          }),
        preview: async () => Result.err(failure),
      })[VISUAL_PREVIEW_TOOL_NAME];
      const execute = tool.execute ?? panic("Visual tool has no executor");
      const output = await execute(
        { title: "Revenue", html: "<p>Revenue</p>", data: {} },
        {
          toolCallId: "visual-call-failed-preview",
          emitCustomEvent: (_name, value) => {
            emissions.push(value);
          },
        },
      );
      expect(emissions).toHaveLength(1);
      expect(origin.accepts(emissions.at(0))).toBe(true);
      expect(output).toEqual([
        {
          type: "text",
          content: JSON.stringify({
            success: true,
            title: "Revenue",
            preview: {
              status: "unavailable",
              reason: code,
              message: failure.message,
            },
          }),
        },
      ]);
      const failures = logs
        .at(grade === "defect" ? "ERROR" : "WARN")
        .filter(({ message }) => message === "visual.preview_failed");
      expect(failures).toHaveLength(1);
      expect(failures.at(0)?.attributes).toMatchObject({
        "error.type": "VisualPreviewError",
        "error.code": code,
        "failure.grade": grade,
        "failure.reason": reason,
        "failure.rule": "brand",
        tool: VISUAL_PREVIEW_TOOL_NAME,
      });
      expect(
        logs.records.filter(
          ({ message }) => message === "visual.preview_failed",
        ),
      ).toHaveLength(1);
      expect(analytics.exceptions()).toHaveLength(grade === "defect" ? 1 : 0);
    },
  );

  test("carries the court and year guidance in its description", () => {
    const tool = createShowVisualTools({
      origin: createVisualResourceOrigin(),
      preview: unavailablePreview,
      store: async () => panic("The description test stores nothing"),
    })[VISUAL_PREVIEW_TOOL_NAME];
    expect(tool.description).toEndWith(VISUAL_SHOWCASE_GUIDANCE);
    expect(tool.description).toContain("facets.courtYear");
    expect(tool.description).toContain(
      "The host supplies the current app theme.",
    );
    expect(tool.description).not.toContain("stella-light");
    expect(tool.description).not.toContain("stella-dark");
  });

  test("has a serializable input contract and emits its native resource", async () => {
    const origin = createVisualResourceOrigin();
    const fileId = createSafeId<"userFile">();
    let saved = 0;
    const tool = createShowVisualTools({
      origin,
      preview: unavailablePreview,
      store: async (visual) => {
        saved += 1;
        expect(visual.title).toBe("Revenue");
        expect(String(visual.html)).toBe("<p>revenue</p>");
        expect(visual.data).toEqual({ revenue: 42 });
        return Result.ok({ fileId, document: "<!doctype html><p>Revenue</p>" });
      },
    })[VISUAL_PREVIEW_TOOL_NAME];
    expect(convertSchemaToJsonSchema(tool.inputSchema)).toMatchObject({
      type: "object",
    });
    const execute = tool.execute ?? panic("Visual tool has no executor");
    const emissions: unknown[] = [];
    const output = await execute(
      {
        title: " Revenue ",
        html: "<p>revenue</p><style>p { color: red }</style>",
        data: { revenue: 42 },
      },
      {
        toolCallId: "visual-call-one",
        emitCustomEvent: (name, value) => {
          expect(name).toBe("ui-resource");
          emissions.push(value);
        },
      },
    );
    expect(output).toEqual([
      {
        type: "text",
        content: JSON.stringify({
          success: true,
          title: "Revenue",
          preview: {
            status: "unavailable",
            reason: "not-configured",
            message: "Preview is not configured",
          },
        }),
      },
    ]);
    expect(saved).toBe(1);
    expect(emissions).toHaveLength(1);
    expect(origin.accepts(emissions.at(0))).toBe(true);
  });

  test("publishes one native resource before requesting the composed page preview once", async () => {
    const document = "<!doctype html><p>Revenue</p>";
    const preview = {
      png: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
      consoleErrors: [],
      blockedRequests: 0,
      size: { width: 1200, height: 320 },
      readyFired: true,
    } satisfies VisualPreviewOutput;
    const emissions: unknown[] = [];
    let invocations = 0;
    const tool = createShowVisualTools({
      origin: createVisualResourceOrigin(),
      store: async () =>
        Result.ok({ fileId: createSafeId<"userFile">(), document }),
      preview: async (received) => {
        expect(emissions).toHaveLength(1);
        expect(received).toBe(document);
        invocations += 1;
        return Result.ok(preview);
      },
    })[VISUAL_PREVIEW_TOOL_NAME];
    const execute = tool.execute ?? panic("Visual tool has no executor");
    const output = await execute(
      { title: "Revenue", html: "<p>Revenue</p>", data: {} },
      {
        toolCallId: "visual-call-preview",
        emitCustomEvent: (_name, value) => {
          emissions.push(value);
        },
      },
    );
    expect(invocations).toBe(1);
    expect(emissions).toHaveLength(1);
    expect(output).toEqual([
      {
        type: "text",
        content: JSON.stringify({
          success: true,
          title: "Revenue",
          preview: {
            consoleErrors: [],
            blockedRequests: 0,
            size: preview.size,
            readyFired: true,
          },
        }),
      },
      {
        type: "image",
        source: { type: "data", value: preview.png, mimeType: "image/png" },
      },
    ]);
    expect(logs.at("ERROR")).toEqual([]);
    expect(analytics.exceptions()).toEqual([]);
  });

  test("keeps publication successful when the optional preview rejects", async () => {
    const origin = createVisualResourceOrigin();
    const emissions: unknown[] = [];
    let publications = 0;
    let previews = 0;
    const tool = createShowVisualTools({
      origin,
      store: async () => {
        publications += 1;
        return Result.ok({
          fileId: createSafeId<"userFile">(),
          document: "<!doctype html><p>Revenue</p>",
        });
      },
      preview: async () => {
        previews += 1;
        expect(emissions).toHaveLength(1);
        throw new VisualPreviewError({
          code: "unavailable",
          message: "Preview invocation rejected",
        });
      },
    })[VISUAL_PREVIEW_TOOL_NAME];
    const execute = tool.execute ?? panic("Visual tool has no executor");
    const output = await execute(
      { title: "Revenue", html: "<p>Revenue</p>", data: {} },
      {
        toolCallId: "visual-call-rejected-preview",
        emitCustomEvent: (_name, value) => {
          emissions.push(value);
        },
      },
    );
    expect(publications).toBe(1);
    expect(previews).toBe(1);
    expect(emissions).toHaveLength(1);
    expect(origin.accepts(emissions.at(0))).toBe(true);
    expect(output).toEqual([
      {
        type: "text",
        content: JSON.stringify({
          success: true,
          title: "Revenue",
          preview: {
            status: "unavailable",
            reason: "unavailable",
            message:
              "The generated view was published; its preview is unavailable.",
          },
        }),
      },
    ]);
    expect(
      logs
        .at("ERROR")
        .filter(({ message }) => message === "visual.preview_failed"),
    ).toHaveLength(1);
    expect(analytics.exceptions()).toHaveLength(1);
  });

  test("keeps data checks at execution after their provider projection", async () => {
    let saved = 0;
    const emissions: unknown[] = [];
    const tool = createShowVisualTools({
      origin: createVisualResourceOrigin(),
      preview: unavailablePreview,
      store: async () => {
        saved += 1;
        return Result.ok({
          fileId: createSafeId<"userFile">(),
          document: "<!doctype html><p>Revenue</p>",
        });
      },
    })[VISUAL_PREVIEW_TOOL_NAME];
    const schema = convertSchemaToJsonSchema(tool.inputSchema);
    expect(schema?.properties?.["data"]).toEqual({});
    const execute = tool.execute ?? panic("Visual tool has no executor");
    let deep: unknown = 0;
    for (let depth = 0; depth < 33; depth += 1) {
      deep = [deep];
    }
    for (const data of [Number.POSITIVE_INFINITY, deep, "é".repeat(524_288)]) {
      const error = await rejectionOf(
        Promise.resolve(
          execute(
            {
              title: "Revenue",
              html: "<p>Revenue</p>",
              data,
            },
            {
              toolCallId: "visual-call-one",
              emitCustomEvent: (_name, value) => {
                emissions.push(value);
              },
            },
          ),
        ),
      );
      expect(error).toBeInstanceOf(ChatToolError);
      expect(error).toMatchObject({
        kind: "invalid-input",
        message: expect.stringContaining("finite JSON data"),
      });
    }
    expect(saved).toBe(0);
    expect(emissions).toHaveLength(0);
  });

  test("refuses invalid decision identifiers before publication or preview", async () => {
    let saved = 0;
    let previews = 0;
    const emissions: unknown[] = [];
    const tool = createShowVisualTools({
      origin: createVisualResourceOrigin(),
      store: async () => {
        saved += 1;
        return Result.ok({
          fileId: createSafeId<"userFile">(),
          document: "<p>Decisions</p>",
        });
      },
      preview: async () => {
        previews += 1;
        return unavailablePreview();
      },
    })[VISUAL_PREVIEW_TOOL_NAME];
    const execute = tool.execute ?? panic("Visual tool has no executor");
    for (const decisionId of ["", "\ud800", "x".repeat(257)]) {
      const error = await rejectionOf(
        Promise.resolve(
          execute(
            {
              title: "Decisions",
              html: "<p>Decisions</p>",
              data: {},
              links: [{ id: "one", decisionId }],
            },
            {
              toolCallId: "visual-call-one",
              emitCustomEvent: (_name, value) => {
                emissions.push(value);
              },
            },
          ),
        ),
      );
      expect(error).toBeInstanceOf(ChatToolError);
      expect(error).toMatchObject({
        kind: "invalid-input",
        message: expect.stringContaining("decision identifiers"),
      });
    }
    expect(saved).toBe(0);
    expect(previews).toBe(0);
    expect(emissions).toHaveLength(0);
  });

  test("refuses unused data before storage and propagates a storage failure", async () => {
    let saved = 0;
    const emissions: unknown[] = [];
    const context = {
      toolCallId: "visual-call-one",
      emitCustomEvent: (_name: string, value: unknown) => emissions.push(value),
    };
    const tool = createShowVisualTools({
      origin: createVisualResourceOrigin(),
      preview: unavailablePreview,
      store: async () => {
        saved += 1;
        return Result.err(
          new ChatToolError({
            kind: "server-defect",
            message: "Storage unavailable",
          }),
        );
      },
    })[VISUAL_PREVIEW_TOOL_NAME];
    const execute = tool.execute ?? panic("Visual tool has no executor");
    expect(
      await rejectionOf(
        Promise.resolve(
          execute(
            { title: "Revenue", html: "<p>Revenue</p>", data: { unused: 42 } },
            context,
          ),
        ),
      ),
    ).toMatchObject({
      message:
        "Remove unreferenced data key unused, or reference it literally in the page.",
    });
    expect(saved).toBe(0);
    expect(
      await rejectionOf(
        Promise.resolve(
          execute(
            { title: "Revenue", html: "<p>revenue</p>", data: { revenue: 42 } },
            context,
          ),
        ),
      ),
    ).toMatchObject({ message: "Storage unavailable" });
    expect(saved).toBe(1);
    expect(emissions).toHaveLength(0);
  });
});
