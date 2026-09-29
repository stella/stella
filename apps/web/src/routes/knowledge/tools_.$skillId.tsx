import { createFileRoute } from "@tanstack/react-router";

import { SkillEditor } from "@/routes/knowledge/-components/skill-editor";

export const Route = createFileRoute("/knowledge/tools_/$skillId")({
  component: SkillEditorPage,
});

function SkillEditorPage() {
  const skillId = Route.useParams({ select: (params) => params.skillId });
  return <SkillEditor skillId={skillId} />;
}
