import { describe, expect, test } from "bun:test";

import { hashSkillPackage, validateSkillPackage } from "./format";

const skill = (body = "Instructions", metadata = "") => `---
name: example-skill
description: Example
metadata:
${metadata || "  stella-display-name: Example"}
---
${body}`;

const diagnosticTypes = (
  files: readonly { path: string; content: string }[],
) => {
  const result = validateSkillPackage({
    files,
    tools: { type: "check", known: new Set(["known"]) },
  });
  expect(result.isErr()).toBe(true);
  return result.isErr() ? result.error.map(({ type }) => type) : [];
};

describe("skill package format", () => {
  test("accepts and classifies a complete package", () => {
    const result = validateSkillPackage({
      files: [
        { path: "SKILL.md", content: skill("Read `references/check.md`.") },
        { path: "references/check.md", content: "check" },
      ],
      tools: { type: "check", known: new Set() },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.resources).toEqual([
        { path: "references/check.md", content: "check" },
      ]);
    }
  });

  test("returns ancillary files as skipped without invalidating the package", () => {
    const result = validateSkillPackage({
      files: [
        { path: "SKILL.md", content: skill() },
        { path: "README.md", content: "Read me" },
        { path: "LICENSE.txt", content: "License" },
        { path: "notes/context.md", content: "Nested notes" },
        { path: "knowledge/context.md", content: "Legacy folder" },
      ],
      tools: { type: "deferred" },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.skipped).toEqual([
        { path: "README.md", reason: "folder" },
        { path: "LICENSE.txt", reason: "folder" },
        { path: "notes/context.md", reason: "folder" },
        { path: "knowledge/context.md", reason: "folder" },
      ]);
    }
  });

  test("defers tool registry checks while enforcing the required-tool limit", () => {
    const tools = Array.from({ length: 9 }, (_, index) => `tool_${index}`).join(
      " ",
    );
    const result = validateSkillPackage({
      files: [
        {
          path: "SKILL.md",
          content: skill("Instructions", `  stella-required-tools: ${tools}`),
        },
      ],
      tools: { type: "deferred" },
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toContainEqual({
        type: "limit_exceeded",
        field: "metadata.stella-required-tools",
        limit: 8,
      });
      expect(
        result.error.some(({ type }) => type === "required_tool_unknown"),
      ).toBe(false);
    }
  });

  test("rejects malformed values for every registered metadata key", () => {
    for (const key of [
      "stella-chat-documented-reads",
      "stella-chat-excluded-tools",
      "stella-display-name",
      "stella-required-tools",
    ]) {
      expect(
        diagnosticTypes([
          {
            path: "SKILL.md",
            content: skill("Instructions", `  ${key}: '   '`),
          },
        ]),
      ).toContain("metadata_value_invalid");
    }
  });

  test("ignores templated resource paths that are not concrete package paths", () => {
    const result = validateSkillPackage({
      files: [
        {
          path: "SKILL.md",
          content: skill("Read `references/jurisdictions/<code>.md`."),
        },
      ],
      tools: { type: "deferred" },
    });

    expect(result.isOk()).toBe(true);
  });

  test("reports malformed and missing entrypoints", () => {
    expect(diagnosticTypes([])).toContain("entrypoint_missing");
    expect(
      diagnosticTypes([{ path: "SKILL.md", content: "no frontmatter" }]),
    ).toContain("frontmatter_invalid");
  });

  test("reports every package policy diagnostic", () => {
    const result = diagnosticTypes([
      {
        path: "SKILL.md",
        content: skill(
          "Read `references/missing.md`.",
          "  stella-required-tools: missing\n  stella-unknown: value",
        )
          .replace("example-skill", "Invalid Name")
          .replace("Example\nmetadata", "Example\u202e\nmetadata"),
      },
      { path: "references/UPPER.md", content: "invalid path" },
      { path: "references/file.exe", content: "invalid extension" },
      { path: "references/ok.md", content: "one" },
      { path: "references/ok.md", content: "two" },
    ]);

    expect(new Set(result)).toEqual(
      new Set([
        "bidi_control",
        "metadata_key_unknown",
        "name_invalid",
        "required_tool_unknown",
        "resource_duplicate",
        "resource_path_invalid",
        "resource_reference_missing",
      ]),
    );
  });

  test("hash covers resource paths and content in canonical order", () => {
    const first = hashSkillPackage({
      source: skill(),
      resources: [
        { path: "references/b.md", content: "b" },
        { path: "references/a.md", content: "a" },
      ],
    });
    const reordered = hashSkillPackage({
      source: skill(),
      resources: [
        { path: "references/a.md", content: "a" },
        { path: "references/b.md", content: "b" },
      ],
    });
    const changed = hashSkillPackage({
      source: skill(),
      resources: [{ path: "references/a.md", content: "changed" }],
    });

    expect(first).toBe(reordered);
    expect(changed).not.toBe(first);
  });
});
