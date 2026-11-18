import { describe, expect, test } from "bun:test";

import { SKILL_RESOURCE_PATH_PATTERN as FORMAT_PATTERN } from "@stll/skills/format";

import { RESOURCE_PATH_PATTERN } from "@/api/lib/agent-skills/resource-path";

describe("skill resource path grammar", () => {
  test("the editor's pattern is the one package imports validate with", () => {
    expect(RESOURCE_PATH_PATTERN.source).toBe(FORMAT_PATTERN.source);
    expect(RESOURCE_PATH_PATTERN.flags).toBe(FORMAT_PATTERN.flags);
  });

  test("accepts spec-style names and refuses unsafe ones", () => {
    expect(RESOURCE_PATH_PATTERN.test("references/REFERENCE.md")).toBe(true);
    expect(RESOURCE_PATH_PATTERN.test("notes/Smlouva o dílo.md")).toBe(true);
    expect(RESOURCE_PATH_PATTERN.test("/etc/passwd")).toBe(false);
    expect(RESOURCE_PATH_PATTERN.test("references/../x.md")).toBe(false);
    expect(RESOURCE_PATH_PATTERN.test("references\\x.md")).toBe(false);
  });
});
