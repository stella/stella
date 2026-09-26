import { describe, expect, test } from "bun:test";

import { hashSkillPackageContent } from "@/api/lib/agent-skills/content-hash";

const baseSkill = {
  body: "Summarise this document.",
  compatibility: null,
  description: "Get a structured summary",
  license: null,
  metadata: { author: "Stella", category: "review" },
  name: "Summarise a document",
  resources: [
    { path: "knowledge/a.md", content: "First." },
    { path: "references/b.md", content: "Second." },
  ],
  version: null,
};

type SkillFixture = Parameters<typeof hashSkillPackageContent>[0];

describe("skill content hashing", () => {
  test("changes when any installed field changes", () => {
    const variants: Record<string, SkillFixture> = {
      name: { ...baseSkill, name: "Review a document" },
      description: { ...baseSkill, description: "Review document risks" },
      version: { ...baseSkill, version: "1.0.0" },
      license: { ...baseSkill, license: "MIT" },
      compatibility: { ...baseSkill, compatibility: "stella 1.x" },
      "metadata value": {
        ...baseSkill,
        metadata: { ...baseSkill.metadata, author: "Someone" },
      },
      "metadata key": { ...baseSkill, metadata: { author: "Stella" } },
      body: { ...baseSkill, body: "Find the risks." },
      "resource content": {
        ...baseSkill,
        resources: [
          { path: "knowledge/a.md", content: "Changed." },
          { path: "references/b.md", content: "Second." },
        ],
      },
      "resource path": {
        ...baseSkill,
        resources: [
          { path: "knowledge/renamed.md", content: "First." },
          { path: "references/b.md", content: "Second." },
        ],
      },
      "resource removed": {
        ...baseSkill,
        resources: [{ path: "knowledge/a.md", content: "First." }],
      },
    };
    const baseHash = hashSkillPackageContent(baseSkill);

    const hashes = Object.values(variants).map(hashSkillPackageContent);

    for (const hash of hashes) {
      expect(hash).not.toBe(baseHash);
    }
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  test("tells an absent optional field from an empty one", () => {
    expect(hashSkillPackageContent({ ...baseSkill, version: "" })).not.toBe(
      hashSkillPackageContent(baseSkill),
    );
  });

  test("does not depend on the order resources or metadata are listed in", () => {
    expect(
      hashSkillPackageContent({
        ...baseSkill,
        metadata: { category: "review", author: "Stella" },
        resources: baseSkill.resources.toReversed(),
      }),
    ).toBe(hashSkillPackageContent(baseSkill));
  });
});
