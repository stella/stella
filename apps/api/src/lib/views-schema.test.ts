import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import {
  parseViewLayout,
  tViewTemplatePropertySchema,
} from "@/api/lib/views-schema";
import type { ViewLayout } from "@/api/lib/views-schema";

describe("parseViewLayout", () => {
  test("keeps versioned layouts unchanged", () => {
    const layout = {
      version: 1,
      type: "table",
      filters: [],
      sorts: [],
      hiddenProperties: [],
      columnOrder: ["name"],
      columnPinning: [],
    } satisfies ViewLayout;

    expect(parseViewLayout(layout)).toEqual(layout);
  });

  test("rejects unversioned layouts", () => {
    const layout = {
      type: "calendar",
      filters: [],
      sorts: [],
      hiddenProperties: [],
      datePropertyId: "_created-at",
      mode: "month",
    };

    expect(() => parseViewLayout(layout)).toThrow();
  });
});

describe("view template property validation", () => {
  test("accepts saved AI properties with empty prompts", () => {
    expect(
      Value.Check(tViewTemplatePropertySchema, {
        version: 1,
        sourceId: "source_summary",
        name: "Summary",
        content: { version: 1, type: "text" },
        tool: { version: 1, type: "ai-model", prompt: "" },
        createIfMissing: true,
      }),
    ).toBe(true);
  });
});
