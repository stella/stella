import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import {
  hashSkillEntrypoint,
  hashSkillPackage,
  isKnownBinaryResourcePath,
  readSkillResourceReferences,
  SKILL_PACKAGE_LIMITS,
  SKILL_PACKAGE_RESOURCE_PATH_PATTERN,
  validateSkillPackage,
} from "./format";

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
        {
          path: "skill/SKILL.md",
          content: skill("Read `references/check.md`."),
        },
        { path: "skill/references/check.md", content: "check" },
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

  test("keeps files in any folder and any case, as the Agent Skills spec allows", () => {
    const result = validateSkillPackage({
      files: [
        {
          path: "skill/SKILL.md",
          content: skill("Read `references/REFERENCE.md` and `docs/Guide.md`."),
        },
        { path: "skill/README.md", content: "Read me" },
        { path: "skill/LICENSE", content: "License" },
        { path: "skill/notes/context.md", content: "Nested notes" },
        { path: "skill/references/REFERENCE.md", content: "Reference" },
        { path: "skill/docs/Guide.md", content: "Guide" },
        { path: "skill/agents/openai.yaml", content: "interface: {}" },
        { path: "skill/references/Smlouva o dílo.md", content: "Text" },
      ],
      tools: { type: "deferred" },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.skipped).toEqual([]);
      expect(result.value.resources.map(({ path }) => path)).toEqual([
        "LICENSE",
        "README.md",
        "agents/openai.yaml",
        "docs/Guide.md",
        "notes/context.md",
        "references/REFERENCE.md",
        "references/Smlouva o dílo.md",
      ]);
    }
  });

  test("reports binary files as skipped and drops OS metadata unreported", () => {
    const result = validateSkillPackage({
      files: [
        {
          path: "skill/SKILL.md",
          content: skill("Use `assets/logo.png` and `assets/table.dat`."),
        },
        { path: "skill/assets/logo.png", content: "\u0089PNG" },
        { path: "skill/assets/table.dat", content: "a\0b" },
        { path: "skill/.DS_Store", content: "Bud1\0" },
        { path: "skill/references/._check.md", content: "\0" },
        { path: "skill/references/check.md", content: "check" },
      ],
      tools: { type: "deferred" },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.skipped).toEqual([
        { path: "assets/logo.png", reason: "extension" },
        { path: "assets/table.dat", reason: "binary" },
      ]);
      expect(result.value.resources.map(({ path }) => path)).toEqual([
        "references/check.md",
      ]);
    }
  });

  test("does not take a reference to a file the caller skipped for missing", () => {
    const files = [
      { path: "skill/SKILL.md", content: skill("Load `data/rates.dat`.") },
      { path: "skill/data/notes.md", content: "Notes" },
    ];
    expect(
      validateSkillPackage({ files, tools: { type: "deferred" } }).isErr(),
    ).toBe(true);
    expect(
      validateSkillPackage({
        files,
        skippedPaths: new Set(["data/rates.dat"]),
        tools: { type: "deferred" },
      }).isOk(),
    ).toBe(true);
  });

  test("refuses paths that are unsafe to store, serve or unpack", () => {
    for (const path of [
      "references/../escape.md",
      "references/./here.md",
      "references//double.md",
      "references/tab\there.md",
      "references/new\nline.md",
      "references/bidi\u202eexe.md",
      "references/colon:name.md",
      "references/star*.md",
      "references/question?.md",
      "references/pipe|name.md",
      'references/quote"name.md',
      "references/angle<name>.md",
      "references/ leading.md",
      "references/trailing.md ",
      "references/trailing-dot.",
      "references/trailing dot folder./a.md",
    ]) {
      expect(SKILL_PACKAGE_RESOURCE_PATH_PATTERN.test(path)).toBe(false);
    }
    for (const path of [
      "Guide.md",
      "LICENSE",
      ".gitignore",
      "references/REFERENCE.md",
      "references/Smlouva o dílo.md",
      "references/v1.2/notes.md",
      "references/c#.md",
      "references/50%.md",
      "assets/template (copy).txt",
    ]) {
      expect(SKILL_PACKAGE_RESOURCE_PATH_PATTERN.test(path)).toBe(true);
    }
  });

  test("treats paths that differ only in case or Unicode form as one file", () => {
    expect(
      diagnosticTypes([
        { path: "skill/SKILL.md", content: skill() },
        { path: "skill/references/a.md", content: "one" },
        { path: "skill/references/A.md", content: "two" },
      ]),
    ).toEqual(["resource_duplicate"]);
    expect(
      diagnosticTypes([
        { path: "skill/SKILL.md", content: skill() },
        { path: "skill/skill.md", content: "shadow" },
      ]),
    ).toEqual(["resource_duplicate"]);
    expect(
      diagnosticTypes([
        { path: "skill/SKILL.md", content: skill() },
        { path: "skill/references/d\u00edlo.md", content: "composed" },
        { path: "skill/references/di\u0301lo.md", content: "decomposed" },
      ]),
    ).toEqual(["resource_duplicate"]);
  });

  test("checks references only into folders the package uses", () => {
    expect(
      validateSkillPackage({
        files: [
          {
            path: "skill/SKILL.md",
            content: skill(
              "Edit `src/index.ts`, see `https://example.test/a.md`, " +
                "`references/check.md#usage` and `docs/*.md`.",
            ),
          },
          { path: "skill/references/check.md", content: "check" },
        ],
        tools: { type: "deferred" },
      }).isOk(),
    ).toBe(true);
    expect(
      diagnosticTypes([
        { path: "skill/SKILL.md", content: skill("Read `docs/missing.md`.") },
        { path: "skill/docs/present.md", content: "present" },
      ]),
    ).toEqual(["resource_reference_missing"]);
    expect(
      readSkillResourceReferences("`Docs/Guide.md` and `a b/c.md`"),
    ).toEqual(["Docs/Guide.md"]);
  });

  test("api-contract holds the same path grammar for browsers", () => {
    // @stll/api-contract cannot import this package, so it carries a copy.
    const source = readFileSync(
      nodePath.join(import.meta.dir, "../../api-contract/src/agent-skills.ts"),
      "utf-8",
    );
    const copy =
      /export const SKILL_RESOURCE_PATH_PATTERN =\s*\/(.+)\/u;/u.exec(
        source,
      )?.[1];
    expect(copy).toBe(SKILL_PACKAGE_RESOURCE_PATH_PATTERN.source);
  });

  test("knows binary files by extension in any case", () => {
    expect(isKnownBinaryResourcePath("assets/Logo.PNG")).toBe(true);
    expect(isKnownBinaryResourcePath("assets/report.pdf")).toBe(true);
    expect(isKnownBinaryResourcePath("assets/diagram.svg")).toBe(false);
    expect(isKnownBinaryResourcePath("assets/.png")).toBe(false);
    expect(isKnownBinaryResourcePath("scripts/run")).toBe(false);
  });

  test("defers tool registry checks while enforcing the required-tool limit", () => {
    const tools = Array.from({ length: 9 }, (_, index) => `tool_${index}`).join(
      " ",
    );
    const result = validateSkillPackage({
      files: [
        {
          path: "skill/SKILL.md",
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

  test("stores a resource up to the resource cap and refuses one past it", () => {
    const limit = SKILL_PACKAGE_LIMITS.resourceMaxChars;
    // A text larger than one model window still fits a single stored file.
    expect(limit).toBeGreaterThan(
      SKILL_PACKAGE_LIMITS.resourceModelContextMaxChars,
    );
    // Every file at the cap, in its widest UTF-8 form, fits one pack.
    expect(limit * 4).toBeLessThanOrEqual(
      SKILL_PACKAGE_LIMITS.archiveUncompressedMaxBytes,
    );
    const validate = (content: string) =>
      validateSkillPackage({
        files: [
          { path: "skill/SKILL.md", content: skill() },
          { path: "skill/references/commentary.txt", content },
        ],
        tools: { type: "deferred" },
      });

    const atCap = validate("a".repeat(limit));
    expect(atCap.isOk()).toBe(true);
    if (atCap.isOk()) {
      expect(atCap.value.resources.at(0)?.content.length).toBe(limit);
    }
    const pastCap = validate("a".repeat(limit + 1));
    expect(pastCap.isErr()).toBe(true);
    if (pastCap.isErr()) {
      expect(pastCap.error).toContainEqual({
        type: "limit_exceeded",
        field: "references/commentary.txt",
        limit,
      });
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
            path: "skill/SKILL.md",
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
          path: "skill/SKILL.md",
          content: skill("Read `references/jurisdictions/<code>.md`."),
        },
      ],
      tools: { type: "deferred" },
    });

    expect(result.isOk()).toBe(true);
  });

  test("ignores references to resource extensions the package cannot store", () => {
    const result = validateSkillPackage({
      files: [
        {
          path: "skill/SKILL.md",
          content: skill("Use `assets/template.docx`."),
        },
      ],
      tools: { type: "deferred" },
    });

    expect(result.isOk()).toBe(true);
  });

  test("reports missing references to resources the package can store", () => {
    const result = validateSkillPackage({
      files: [
        {
          path: "skill/SKILL.md",
          content: skill("Read `references/missing.md`."),
        },
      ],
      tools: { type: "deferred" },
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toContainEqual({
        type: "resource_reference_missing",
        path: "references/missing.md",
      });
    }
  });

  test("reports malformed and missing entrypoints", () => {
    expect(diagnosticTypes([])).toContain("entrypoint_missing");
    expect(
      diagnosticTypes([{ path: "skill/SKILL.md", content: "no frontmatter" }]),
    ).toContain("frontmatter_invalid");
  });

  test("reports every package policy diagnostic", () => {
    const result = diagnosticTypes([
      {
        path: "skill/SKILL.md",
        content: skill(
          "Read `references/missing.md`.",
          "  stella-required-tools: missing\n  stella-unknown: value",
        )
          .replace("example-skill", "Invalid Name")
          .replace("Example\nmetadata", "Example\u202e\nmetadata"),
      },
      { path: "skill/references/bad:name.md", content: "invalid path" },
      { path: "skill/references/file.exe", content: "skipped, binary" },
      { path: "skill/references/ok.md", content: "one" },
      { path: "skill/references/ok.md", content: "two" },
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

  test("entrypoint hash retains the established SKILL.md contract", () => {
    expect(hashSkillEntrypoint("fixed skill source\n")).toBe(
      "16fcce649cca188da1bed492dd6f6895db332f627919adbcc37cb9e88eb1c748",
    );
  });
});
