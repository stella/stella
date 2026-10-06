import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  generatedVisualInputSchema,
  generatedVisualPartSchema,
  GENERATED_VISUAL_MIME_TYPE,
  GENERATED_VISUAL_URI_PREFIX,
  SHOW_VISUAL_TOOL_NAME,
} from "./generated-visual";

describe("generated visual contract", () => {
  test("preserves bounded JSON, presentation text and optional decision links", () => {
    const input = {
      title: " Revenue ",
      html: "<p>revenue</p>",
      data: { revenue: 42 },
      links: [{ id: "decision-one", decisionId: "case-one" }],
    };
    const parsed = v.parse(generatedVisualInputSchema, input);
    expect(parsed.title).toBe(input.title);
    expect(parsed.data).toEqual(input.data);
    expect(parsed.links).toEqual(input.links);
    expect(
      v.safeParse(generatedVisualInputSchema, {
        ...input,
        title: "x".repeat(121),
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(generatedVisualInputSchema, { ...input, charts: [] }).success,
    ).toBe(false);
    expect(
      v.safeParse(generatedVisualInputSchema, {
        ...input,
        links: [{ id: "", decisionId: "case-one" }],
      }).success,
    ).toBe(false);
    for (const data of [null, false, 42, "text", [1, 2]]) {
      expect(
        v.safeParse(generatedVisualInputSchema, { ...input, data }).success,
      ).toBe(true);
    }
  });

  test("bounds JSON values, nesting, node count and encoded bytes", () => {
    const input = { title: "Table", html: "<p>Values</p>" };
    for (const data of [
      { value: Number.NaN },
      { value: Infinity },
      { value: undefined },
      { value: new Date() },
      { value: "é".repeat(524_288) },
      { value: Array.from({ length: 50_001 }, () => 0) },
    ]) {
      expect(
        v.safeParse(generatedVisualInputSchema, { ...input, data }).success,
      ).toBe(false);
    }
    let nested: unknown = 0;
    for (let depth = 0; depth < 33; depth += 1) {
      nested = [nested];
    }
    expect(
      v.safeParse(generatedVisualInputSchema, {
        ...input,
        data: { value: nested },
      }).success,
    ).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle["value"] = cycle;
    expect(
      v.safeParse(generatedVisualInputSchema, { ...input, data: cycle })
        .success,
    ).toBe(false);
  });
});

describe("generated visual resource", () => {
  test("carries a private attachment reference and title", () => {
    const part = {
      type: "ui-resource",
      resource: {
        uri: `${GENERATED_VISUAL_URI_PREFIX}0199ba00-0000-7000-8000-000000000001`,
        mimeType: GENERATED_VISUAL_MIME_TYPE,
        text: "Court overview",
      },
      toolCallId: "visual-call-one",
      toolName: SHOW_VISUAL_TOOL_NAME,
    };
    expect(v.safeParse(generatedVisualPartSchema, part).success).toBe(true);
    for (const candidate of [
      { ...part, serverId: "connector" },
      { ...part, toolName: "other-tool" },
      {
        ...part,
        resource: { ...part.resource, uri: "https://example.test/view" },
      },
      { ...part, resource: { ...part.resource, blob: "payload" } },
      { ...part, resource: { ...part.resource, text: "x".repeat(121) } },
      { ...part, resource: { ...part.resource, mimeType: "unknown" } },
    ]) {
      expect(v.safeParse(generatedVisualPartSchema, candidate).success).toBe(
        false,
      );
    }
  });
});
