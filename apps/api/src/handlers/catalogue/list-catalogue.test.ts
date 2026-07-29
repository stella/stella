import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import { appendCustomSkillEntries } from "./list-catalogue";

const organizationId = toSafeId<"organization">("org-current");

describe("appendCustomSkillEntries", () => {
  test("shows enabled team skills to members without a management handle", () => {
    const response: Parameters<typeof appendCustomSkillEntries>[0]["response"] =
      [];

    appendCustomSkillEntries({
      canDeleteTeamSkills: false,
      curatedSlugs: new Set(),
      organizationId,
      response,
      skills: [
        {
          description: "Review contracts.",
          enabled: true,
          id: "skill-team",
          license: null,
          name: "Contract review",
          scope: "team",
          slug: "contract-review",
        },
      ],
    });

    expect(response).toHaveLength(1);
    expect(response[0]).toMatchObject({
      chatSkillId: "skill-team",
      installedSkillId: null,
      slug: "contract-review",
    });
  });

  test("prefers a member's private skill over a same-slug team skill", () => {
    const response: Parameters<typeof appendCustomSkillEntries>[0]["response"] =
      [];

    appendCustomSkillEntries({
      canDeleteTeamSkills: false,
      curatedSlugs: new Set(),
      organizationId,
      response,
      skills: [
        {
          description: "Team version.",
          enabled: true,
          id: "skill-team",
          license: null,
          name: "Review",
          scope: "team",
          slug: "review",
        },
        {
          description: "Private version.",
          enabled: false,
          id: "skill-private",
          license: null,
          name: "Review",
          scope: "private",
          slug: "review",
        },
      ],
    });

    expect(response).toHaveLength(1);
    expect(response[0]).toMatchObject({
      chatSkillId: "skill-private",
      installedSkillId: "skill-private",
      slug: "review",
    });
  });
});
