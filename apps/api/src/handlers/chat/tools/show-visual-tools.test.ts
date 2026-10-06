import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { SHOW_VISUAL_TOOL_NAME } from "@stll/api-contract/generated-visual";
import { rejectionOf } from "@stll/property-testing/rejection";

import { createVisualResourceOrigin } from "@/api/handlers/visual-sandbox/resource-origin";
import { createSafeId } from "@/api/lib/branded-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";

import { createShowVisualTools } from "./show-visual-tools";

describe("show visual", () => {
  test("has a serializable input contract and emits its native resource", async () => {
    const origin = createVisualResourceOrigin();
    const fileId = createSafeId<"userFile">();
    let saved = 0;
    const tool = createShowVisualTools({
      origin,
      store: async (visual) => {
        saved += 1;
        expect(visual.title).toBe("Revenue");
        expect(String(visual.html)).toBe("<p>revenue</p>");
        expect(visual.data).toEqual({ revenue: 42 });
        return Result.ok(fileId);
      },
    })[SHOW_VISUAL_TOOL_NAME];
    expect(await convertSchemaToJsonSchema(tool.inputSchema)).toMatchObject({
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
    expect(output).toEqual({ success: true, title: "Revenue" });
    expect(saved).toBe(1);
    expect(emissions).toHaveLength(1);
    expect(origin.accepts(emissions.at(0))).toBe(true);
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
      store: async () => {
        saved += 1;
        return Result.err(
          new ChatToolError({
            kind: "server-defect",
            message: "Storage unavailable",
          }),
        );
      },
    })[SHOW_VISUAL_TOOL_NAME];
    const execute = tool.execute ?? panic("Visual tool has no executor");
    expect(
      await rejectionOf(
        execute(
          { title: "Revenue", html: "<p>Revenue</p>", data: { unused: 42 } },
          context,
        ),
      ),
    ).toMatchObject({
      message:
        "Remove unreferenced data key unused, or reference it literally in the page.",
    });
    expect(saved).toBe(0);
    expect(
      await rejectionOf(
        execute(
          { title: "Revenue", html: "<p>revenue</p>", data: { revenue: 42 } },
          context,
        ),
      ),
    ).toMatchObject({ message: "Storage unavailable" });
    expect(saved).toBe(1);
    expect(emissions).toHaveLength(0);
  });
});
