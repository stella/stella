import { describe, expect, test } from "bun:test";
import * as v from "valibot";

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
    expect(v.is(importSkillsBodySchema, { items: [item] })).toBe(false);
    expect(importSkillsBodySchema.entries.scope).not.toHaveProperty("default");
  });

  test("accepts both supported explicit scopes", () => {
    expect(v.is(importSkillsBodySchema, { items: [item], scope: "team" })).toBe(
      true,
    );
    expect(
      v.is(importSkillsBodySchema, { items: [item], scope: "private" }),
    ).toBe(true);
  });
});
