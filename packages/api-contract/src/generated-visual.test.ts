import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { generatedVisualInputSchema } from "./generated-visual";

describe("generated visual contract", () => {
  test("preserves bounded JSON, presentation text and optional decision links", () => {
    const input = {
      title: " Revenue ",
      html: "<p>revenue</p>",
      data: { revenue: 42 },
      links: [{ id: "decision-one", decisionId: "case-one" }],
    };
    const parsed = v.parse(generatedVisualInputSchema, input);
    expect(parsed.title).toBe("Revenue");
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
