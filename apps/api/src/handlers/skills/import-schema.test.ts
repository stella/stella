import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import { importSkillsBodySchema } from "./import";

const item = {
  integrity: {
    type: "content-hash" as const,
    value: "a".repeat(64),
  },
  sourceUrl: "https://example.com/SKILL.md",
};

describe("skill batch import schema", () => {
  test("requires callers to choose an explicit scope", () => {
    expect(Value.Check(importSkillsBodySchema, { items: [item] })).toBe(false);
    expect(importSkillsBodySchema.properties.scope).not.toHaveProperty(
      "default",
    );
  });

  test("accepts both supported explicit scopes", () => {
    expect(
      Value.Check(importSkillsBodySchema, { items: [item], scope: "team" }),
    ).toBe(true);
    expect(
      Value.Check(importSkillsBodySchema, { items: [item], scope: "private" }),
    ).toBe(true);
  });
});
