import { describe, expect, test } from "bun:test";

import type { CatalogueSkill } from "./catalogue-types";
import { getToolDetailPayload } from "./tool-detail";

describe("getToolDetailPayload", () => {
  test("uses the chat skill id when no edit handle is available", () => {
    const payload = getToolDetailPayload(
      skillEntry({
        chatSkillId: "skill-team",
        installedSkillId: null,
      }),
      "org-1",
    );

    expect(payload.activeSkill).toEqual({
      skillId: "skill-team",
      skillName: "Review Skill",
    });
  });

  test("does not treat the edit handle as chat-readable by itself", () => {
    const payload = getToolDetailPayload(
      skillEntry({
        chatSkillId: null,
        installedSkillId: "skill-edit",
      }),
      "org-1",
    );

    expect(payload.activeSkill).toBeUndefined();
  });
});

const skillEntry = (overrides: Partial<CatalogueSkill>): CatalogueSkill => ({
  author: "Stella",
  chatSkillId: null,
  cost: "free",
  description: "Review skill.",
  displayName: "Review Skill",
  enabled: true,
  icon: null,
  installState: "installed",
  installedConnectorSlug: null,
  installedSkillId: null,
  isLocked: false,
  isRecommendedForOrg: false,
  jurisdictions: [],
  kind: "skill",
  license: "MIT",
  setup: "none",
  slug: "review",
  tags: [],
  ...overrides,
});
