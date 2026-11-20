import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import { packageTexts, toNameWarnings } from "./skill-package-tools";

describe("skill package name warnings", () => {
  test("scan the SKILL.md, paths and contents a call sends", () => {
    expect(
      packageTexts({
        type: "new",
        resources: [
          { content: "Jana Nováková sued.", path: "references/a.md" },
        ],
        scope: "private",
        skillMd: "---\nname: a\ndescription: b\n---\nBody",
      }),
    ).toEqual([
      "---\nname: a\ndescription: b\n---\nBody",
      "references/a.md",
      "Jana Nováková sued.",
    ]);
    expect(
      packageTexts({
        type: "saved",
        changes: {
          deletePaths: ["references/old.md"],
          resources: [{ content: "Text.", path: "references/b.md" }],
          skillMd: undefined,
        },
        skillId: toSafeId<"agentSkill">("44444444-4444-4444-8444-444444444444"),
      }),
    ).toEqual(["references/b.md", "Text."]);
  });

  test("report found names without blocking, and say when the scan failed", () => {
    const names = [{ kind: "person", value: "Jana Nováková" }] as const;
    expect(toNameWarnings(Result.ok([...names]))).toEqual([
      expect.objectContaining({ type: "names_found", names: [...names] }),
    ]);
    expect(toNameWarnings(Result.ok([]))).toEqual([]);
    expect(toNameWarnings(Result.err("scan failed"))).toEqual([
      expect.objectContaining({ type: "names_unchecked" }),
    ]);
  });
});
