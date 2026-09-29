import { createFileRoute } from "@tanstack/react-router";

import { SkillEditor } from "@/routes/knowledge/-components/skill-editor";
import { KnowledgeMemberOnly } from "@/routes/knowledge/-knowledge-member-only";

export const Route = createFileRoute("/knowledge/tools_/$skillId")({
  component: GuardedSkillEditorPage,
});

function SkillEditorPage() {
  const skillId = Route.useParams({ select: (params) => params.skillId });
  return <SkillEditor skillId={skillId} />;
}

function GuardedSkillEditorPage() {
  return (
    <KnowledgeMemberOnly pending={null}>
      {(organizationId) => <SkillEditorPage key={organizationId} />}
    </KnowledgeMemberOnly>
  );
}
