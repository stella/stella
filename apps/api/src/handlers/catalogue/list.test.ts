import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";

import { appendCustomSkillEntries } from "./list";

const userId = toSafeId<"user">("user-current");

const organizationId = toSafeId<"organization">("org-current");

describe("appendCustomSkillEntries", () => {
  test("shows enabled team skills to members without a management handle", () => {
    const response: Parameters<typeof appendCustomSkillEntries>[0]["response"] =
      [];

    appendCustomSkillEntries({
      memberRole: sessionMemberRole("member"),
      userId,
      curatedSlugs: new Set(),
      organizationId,
      response,
      skills: [
        {
          description: "Review contracts.",
          enabled: true,
          id: toSafeId<"agentSkill">("skill-team"),
          origin: "authored",
          userId,
          invocation: "auto",
          boundWorkspaceId: null,
          boundClientId: null,
          license: null,
          name: "Contract review",
          scope: "team",
          slug: "contract-review-anthropic",
        },
      ],
    });

    expect(response).toHaveLength(1);
    expect(response[0]).toMatchObject({
      chatSkillId: "skill-team",
      installedSkillId: null,
      slug: "contract-review-anthropic",
    });
  });

  test("prefers a member's private skill over a same-slug team skill", () => {
    const response: Parameters<typeof appendCustomSkillEntries>[0]["response"] =
      [];

    appendCustomSkillEntries({
      memberRole: sessionMemberRole("member"),
      userId,
      curatedSlugs: new Set(),
      organizationId,
      response,
      skills: [
        {
          description: "Team version.",
          enabled: true,
          id: toSafeId<"agentSkill">("skill-team"),
          origin: "authored",
          userId,
          invocation: "auto",
          boundWorkspaceId: null,
          boundClientId: null,
          license: null,
          name: "Review",
          scope: "team",
          slug: "review",
        },
        {
          description: "Private version.",
          enabled: false,
          id: toSafeId<"agentSkill">("skill-private"),
          origin: "authored",
          userId,
          invocation: "manual",
          boundWorkspaceId: toSafeId<"workspace">(
            "0199a1b2-0000-7000-8000-0000000000aa",
          ),
          boundClientId: null,
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
      // The shown row's own settings, not the shadowed team row's.
      binding: "matter",
      invocation: "manual",
      slug: "review",
    });
  });

  test("hides disabled team skills from members", () => {
    const response: Parameters<typeof appendCustomSkillEntries>[0]["response"] =
      [];

    appendCustomSkillEntries({
      memberRole: sessionMemberRole("member"),
      userId,
      curatedSlugs: new Set(),
      organizationId,
      response,
      skills: [
        {
          description: "Unavailable team version.",
          enabled: false,
          id: toSafeId<"agentSkill">("skill-team"),
          origin: "authored",
          userId,
          invocation: "auto",
          boundWorkspaceId: null,
          boundClientId: null,
          license: null,
          name: "Review",
          scope: "team",
          slug: "review",
        },
      ],
    });

    expect(response).toEqual([]);
  });

  test("shows disabled team skills to managers", () => {
    const response: Parameters<typeof appendCustomSkillEntries>[0]["response"] =
      [];

    appendCustomSkillEntries({
      memberRole: sessionMemberRole("admin"),
      userId,
      curatedSlugs: new Set(),
      organizationId,
      response,
      skills: [
        {
          description: "Manageable team version.",
          enabled: false,
          id: toSafeId<"agentSkill">("skill-team"),
          origin: "authored",
          userId,
          invocation: "auto",
          boundWorkspaceId: null,
          boundClientId: null,
          license: null,
          name: "Review",
          scope: "team",
          slug: "review",
        },
      ],
    });

    expect(response).toHaveLength(1);
    expect(response[0]).toMatchObject({
      enabled: false,
      installedSkillId: "skill-team",
      slug: "review",
    });
  });
});
