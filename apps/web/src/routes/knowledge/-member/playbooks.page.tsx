import { KNOWLEDGE_CATALOGUE_PATHS } from "@/lib/knowledge/knowledge-catalogues";
import { KnowledgeMemberOnly } from "@/routes/knowledge/-knowledge-member-only";
import { MemberPlaybooksPage } from "@/routes/knowledge/-member/member-playbooks-page";
import { PlaybooksPending } from "@/routes/knowledge/-member/playbooks.pending";

/** The organization's playbooks; a visitor without an account reads the
 *  ready-made ones instead. */
export const PlaybooksPage = () => (
  <KnowledgeMemberOnly
    pending={<PlaybooksPending />}
    visitor={{ kind: "catalogue", to: KNOWLEDGE_CATALOGUE_PATHS.playbooks }}
  >
    {(organizationId) => (
      <MemberPlaybooksPage organizationId={organizationId} />
    )}
  </KnowledgeMemberOnly>
);
