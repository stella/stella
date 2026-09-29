import { useTranslations } from "use-intl";

import { KnowledgeLandingView } from "@/features/knowledge/views/knowledge-landing-view";
import type { KnowledgeLandingCard } from "@/features/knowledge/views/knowledge-landing-view";
import { usePermissions } from "@/hooks/use-permissions";
import { useWorkflowsPreviewEnabled } from "@/hooks/use-workflows-preview";
import { knowledgeSections } from "@/lib/knowledge/navigation";

/** A member's Knowledge landing: every section their role opens. */
export const MemberKnowledgeLanding = () => {
  const t = useTranslations();
  const workflowsEnabled = useWorkflowsPreviewEnabled();
  const canUseStyleSets = usePermissions({ styleSet: ["use"] });

  const cards: KnowledgeLandingCard[] = [];
  for (const section of knowledgeSections) {
    if (section.key === "workflows" && !workflowsEnabled) {
      continue;
    }
    if (section.key === "styles" && !canUseStyleSets) {
      continue;
    }
    cards.push({
      key: section.key,
      icon: section.icon,
      title: t(section.titleKey),
      description:
        section.key === "styles"
          ? t("styleSets.description")
          : t(`knowledge.sections.${section.key}.description`),
      to: section.to,
    });
  }

  return <KnowledgeLandingView cards={cards} />;
};
