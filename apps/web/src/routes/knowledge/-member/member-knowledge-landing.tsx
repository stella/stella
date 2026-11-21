import { useTranslations } from "use-intl";

import { KnowledgeLandingView } from "@/features/knowledge/views/knowledge-landing-view";
import { knowledgeSectionDescriptionKey } from "@/features/knowledge/views/knowledge-landing.pending";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { usePermissions } from "@/hooks/use-permissions";
import { useWorkflowsPreviewEnabled } from "@/hooks/use-workflows-preview";
import { memberLandingSections } from "@/lib/knowledge/landing-sections.logic";
import { useConfigStore } from "@/stores/config-store";

/** A member's Knowledge landing: every section their role opens. */
export const MemberKnowledgeLanding = () => {
  const t = useTranslations();
  const workflowsEnabled = useWorkflowsPreviewEnabled();
  const styleSetsGranted = usePermissions({ styleSet: ["use"] });
  const sections = memberLandingSections({
    styleSetsGranted,
    workflowsEnabled,
  });

  // The cards a cold load draws next time are the ones drawn now: keep the
  // sections in this browser.
  const rememberKnowledgeLanding = useConfigStore(
    (state) => state.rememberKnowledgeLanding,
  );
  const sectionKeys = sections.map((section) => section.key);
  const rememberSections = useLatestCallback(() => {
    rememberKnowledgeLanding(sectionKeys);
  });
  // Written when what it holds changes, not on every render.
  const sectionsKey = sectionKeys.join(",");
  useExternalSyncEffect(() => {
    rememberSections();
  }, [sectionsKey, rememberSections]);

  return (
    <KnowledgeLandingView
      cards={sections.map((section) => ({
        key: section.key,
        icon: section.icon,
        title: t(section.titleKey),
        description: t(knowledgeSectionDescriptionKey(section.key)),
        to: section.to,
      }))}
    />
  );
};
