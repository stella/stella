import { SkillEditor } from "@/routes/knowledge/-components/skill-editor";

/** An organization's own skill, opened for editing. */
export function MemberSkillEditorPage({
  organizationId,
  skillId,
}: {
  organizationId: string;
  skillId: string;
}) {
  return <SkillEditor key={`${organizationId}:${skillId}`} skillId={skillId} />;
}
