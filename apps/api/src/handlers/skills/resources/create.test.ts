import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import { SKILL_RESOURCE_KINDS } from "@stll/skills/resource-kinds";

import createSkillResource from "./create";

const { body } = createSkillResource.config;
const withKind = (kind: unknown) => ({
  path: "references/checklist.md",
  content: "",
  kind,
});

describe("skill resource create body", () => {
  test("accepts exactly the resource kinds the database stores", () => {
    for (const kind of SKILL_RESOURCE_KINDS) {
      expect(Value.Check(body, withKind(kind))).toBe(true);
    }
    expect(Value.Check(body, withKind("binary"))).toBe(false);
  });
});
