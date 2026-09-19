import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { templatesSearchSchema } from "@/routes/_protected.knowledge/-templates-search";

const parse = (search: Record<string, unknown>) =>
  v.parse(templatesSearchSchema, search);

describe("templates search params", () => {
  test("carries the open template id", () => {
    expect(parse({ template: "tpl_123" })).toEqual({ template: "tpl_123" });
  });

  test("an absent param leaves the studio closed", () => {
    expect(parse({})).toEqual({ template: undefined });
  });

  test("a non-string value degrades to no open template", () => {
    expect(parse({ template: 1 })).toEqual({ template: undefined });
    expect(parse({ template: ["a", "b"] })).toEqual({ template: undefined });
  });

  test("unrelated params do not fail validation", () => {
    expect(parse({ other: "x", template: "tpl_123" })).toEqual({
      template: "tpl_123",
    });
  });
});
