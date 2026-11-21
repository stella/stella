import { describe, expect, test } from "bun:test";

import { SKILL_PACKAGE_LIMITS } from "@stll/skills/format";

import {
  blockingSkillPackageDiagnostics,
  checkSkillPackage,
} from "./skill-package-check";

const skillMd = ({
  body = "Read `references/elements.md` first.",
  description = "Checks Czech contracts.",
  name = "czech-contracts",
} = {}) => `---
name: ${name}
description: ${description}
---
${body}`;

const text = (path: string, content: string) =>
  ({ content, path, type: "text" }) as const;

describe("checkSkillPackage", () => {
  test("accepts a complete package and describes it", () => {
    const check = checkSkillPackage({
      resources: [
        text("references/elements.md", "Offer and acceptance."),
        text("references/remedies.md", "Damages."),
      ],
      skillMd: skillMd(),
    });

    expect(check.status).toBe("accepted");
    expect(check.diagnostics).toEqual([]);
    expect(check.missingReferences).toEqual([]);
    expect(check.skill).toMatchObject({
      description: "Checks Czech contracts.",
      descriptionChars: "Checks Czech contracts.".length,
      invocation: "auto",
      name: "czech-contracts",
    });
    expect(check.resources).toEqual([
      { chars: 21, path: "references/elements.md" },
      { chars: 8, path: "references/remedies.md" },
    ]);
    expect(check.totals.files).toBe(3);
    expect(check.limits.descriptionMaxChars).toBe(
      SKILL_PACKAGE_LIMITS.descriptionMaxChars,
    );
  });

  test("rejects with a fix for each problem, reading the frontmatter it can", () => {
    const check = checkSkillPackage({
      resources: [text("references/../escape.md", "x")],
      skillMd: skillMd({
        description: "d".repeat(SKILL_PACKAGE_LIMITS.descriptionMaxChars + 1),
        name: "Czech Contracts",
      }),
    });

    expect(check.status).toBe("rejected");
    expect(check.diagnostics.map(({ type }) => type).toSorted()).toEqual([
      "limit_exceeded",
      "name_invalid",
      "resource_path_invalid",
      "resource_reference_missing",
    ]);
    for (const { message } of check.diagnostics) {
      expect(message.length).toBeGreaterThan(0);
    }
    expect(check.missingReferences).toEqual(["references/elements.md"]);
    expect(check.skill?.name).toBe("Czech Contracts");
  });

  test("reports unreadable frontmatter without a summary", () => {
    const check = checkSkillPackage({
      resources: [],
      skillMd: "No frontmatter here.",
    });

    expect(check.status).toBe("rejected");
    expect(check.diagnostics.map(({ type }) => type)).toEqual([
      "frontmatter_invalid",
    ]);
    expect(check.skill).toBeNull();
    expect(check.bodyChars).toBeNull();
  });

  test("a missing reference alone does not block a save", () => {
    const check = checkSkillPackage({ resources: [], skillMd: skillMd() });

    expect(check.status).toBe("rejected");
    expect(check.missingReferences).toEqual(["references/elements.md"]);
    expect(blockingSkillPackageDiagnostics(check)).toEqual([]);
  });

  test("counts a stored file by its path and size without its content", () => {
    const check = checkSkillPackage({
      resources: [
        {
          chars: 5000,
          path: "references/elements.md",
          sizeBytes: 5200,
          type: "stored",
        },
      ],
      skillMd: skillMd(),
    });

    expect(check.status).toBe("accepted");
    expect(check.resources).toEqual([
      { chars: 5000, path: "references/elements.md" },
    ]);
  });

  test("refuses a path that collides with a stored one by case", () => {
    const check = checkSkillPackage({
      resources: [
        { chars: 1, path: "references/a.md", sizeBytes: 1, type: "stored" },
        text("references/A.md", "x"),
      ],
      skillMd: skillMd({ body: "No references." }),
    });

    expect(
      blockingSkillPackageDiagnostics(check).map(({ type }) => type),
    ).toEqual(["resource_duplicate"]);
  });
});
