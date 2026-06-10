import { createFileRoute } from "@tanstack/react-router";

import { SkillEditor } from "@/routes/_protected.knowledge/-components/skill-editor";

export const Route = createFileRoute("/_protected/knowledge/tools_/$skillId")({
  component: SkillEditorPage,
});

function SkillEditorPage() {
  const skillId = Route.useParams({ select: (params) => params.skillId });
  return <SkillEditor skillId={skillId} />;
}
