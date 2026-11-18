import { usePresentationPrefs } from "@/lib/account/presentation-prefs/provider";
import { KNOWLEDGE_CATALOGUE_PATHS } from "@/lib/knowledge/knowledge-catalogues";
import { KnowledgeMemberOnly } from "@/routes/knowledge/-knowledge-member-only";
import { MemberTemplatesPage } from "@/routes/knowledge/-member/member-templates-page";
import { TemplatesLibraryPending } from "@/routes/knowledge/-member/templates.pending";

/** The organization's template library; a visitor without an account reads
 *  the published catalogue instead. */
export const TemplatesPage = () => {
  const {
    prefs: { templateDensity },
  } = usePresentationPrefs();
  return (
    <KnowledgeMemberOnly
      pending={<TemplatesLibraryPending density={templateDensity} />}
      visitor={{ kind: "catalogue", to: KNOWLEDGE_CATALOGUE_PATHS.templates }}
    >
      {(organizationId) => (
        <MemberTemplatesPage organizationId={organizationId} />
      )}
    </KnowledgeMemberOnly>
  );
};
