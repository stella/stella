import { getRouteApi } from "@tanstack/react-router";

import { KnowledgeMemberOnly } from "@/routes/knowledge/-knowledge-member-only";
import { MemberSkillEditorPage } from "@/routes/knowledge/-member/member-skill-editor-page";
import { ToolEntryNotFound } from "@/routes/knowledge/-tool-entry-not-found";
import {
  ToolSkillPending,
  ToolSkillShell,
} from "@/routes/knowledge/-tools/tool-skill.pending";

const skillRouteApi = getRouteApi("/knowledge/tools_/skills/$skillId");

/** An organization's own skill, in its editor. A skill belongs to an
 *  organization: without an account there is nothing to show. */
export const ToolSkillPage = () => {
  const skillId = skillRouteApi.useParams({ select: (p) => p.skillId });
  return (
    <KnowledgeMemberOnly
      pending={<ToolSkillPending />}
      visitor={{ kind: "page", page: <ToolEntryNotFound /> }}
    >
      {(organizationId) => (
        <ToolSkillShell>
          <MemberSkillEditorPage
            organizationId={organizationId}
            skillId={skillId}
          />
        </ToolSkillShell>
      )}
    </KnowledgeMemberOnly>
  );
};
