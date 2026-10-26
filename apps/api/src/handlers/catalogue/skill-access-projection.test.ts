import { expect, test } from "bun:test";

import {
  canManageSkill,
  canReadActiveSkillBody,
} from "@/api/lib/agent-skills/access";
import { UNBOUND } from "@/api/lib/agent-skills/binding";
import { toSafeId } from "@/api/lib/branded-types";
import {
  authorizedMemberRole,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";

import { appendCustomSkillEntries } from "./list";
import { resolveCatalogueSkillHandleMaps } from "./skill-handles";

const userId = toSafeId<"user">("skill-author");
const organizationId = toSafeId<"organization">("org-current");
const bindings = [
  UNBOUND,
  {
    boundClientId: null,
    boundWorkspaceId: toSafeId<"workspace">("matter-current"),
  },
  {
    boundClientId: toSafeId<"contact">("client-current"),
    boundWorkspaceId: null,
  },
];
const scopes = ["private", "team"] as const;
const rows = bindings.flatMap((binding) =>
  scopes.flatMap((scope) =>
    [false, true].flatMap((enabled) =>
      [userId, toSafeId<"user">("other-author")].map(
        (authorId) =>
          ({
            ...binding,
            description: "Review contracts.",
            enabled,
            id: toSafeId<"agentSkill">("skill-review"),
            invocation: "auto",
            license: null,
            name: "Review",
            origin: "authored",
            scope,
            slug: "review",
            userId: authorId,
          }) as const,
      ),
    ),
  ),
);
const authorities = [
  sessionMemberRole("member"),
  sessionMemberRole("admin"),
  sessionMemberRole("owner"),
  authorizedMemberRole({
    role: "admin",
    credential: { type: "attenuated", permissions: { agentSkill: ["update"] } },
  }),
  authorizedMemberRole({
    role: "admin",
    credential: { type: "attenuated", permissions: { agentSkill: ["delete"] } },
  }),
  authorizedMemberRole({
    role: "admin",
    credential: {
      type: "attenuated",
      permissions: { agentSkill: ["comment"] },
    },
  }),
];

test("both catalogue paths project canonical skill access across the role and binding class", () => {
  for (const memberRole of authorities) {
    for (const skill of rows) {
      const canDelete = canManageSkill({
        memberRole,
        skill,
        spends: "delete",
        userId,
      });
      const canRead = canReadActiveSkillBody({
        ...skill,
        memberRole,
        skillUserId: skill.userId,
        userId,
      });
      const response: Parameters<
        typeof appendCustomSkillEntries
      >[0]["response"] = [];
      appendCustomSkillEntries({
        curatedSlugs: new Set(),
        memberRole,
        organizationId,
        response,
        skills: [skill],
        userId,
      });
      expect(response).toHaveLength(canRead || canDelete ? 1 : 0);
      expect(response.at(0)?.installedSkillId ?? null).toBe(
        canDelete ? skill.id : null,
      );
      expect(response.at(0)?.chatSkillId ?? null).toBe(
        canRead ? skill.id : null,
      );

      const handles = resolveCatalogueSkillHandleMaps({
        memberRole,
        rows: [skill],
        userId,
      });
      expect(handles.installedSkillIdBySlug.get(skill.slug)).toBe(
        canDelete ? skill.id : undefined,
      );
      expect(handles.chatSkillIdBySlug.get(skill.slug)).toBe(
        canRead ? skill.id : undefined,
      );
    }
  }
});
