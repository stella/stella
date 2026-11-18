import { Suspense } from "react";

import { KNOWLEDGE_CATALOGUE_PATHS } from "@/lib/knowledge/knowledge-catalogues";
import { KnowledgeMemberOnly } from "@/routes/knowledge/-knowledge-member-only";
import { MemberToolsPage } from "@/routes/knowledge/-member/member-tools-page";
import { ToolsPending } from "@/routes/knowledge/-tools/tools.pending";

/** The organization's tools; a visitor without an account reads the
 *  published list instead. */
export const ToolsPage = () => (
  <KnowledgeMemberOnly
    pending={<ToolsPending />}
    visitor={{ kind: "catalogue", to: KNOWLEDGE_CATALOGUE_PATHS.tools }}
  >
    {(organizationId) => (
      // The page reads the organization's catalogue before it renders.
      <Suspense fallback={<ToolsPending />}>
        <MemberToolsPage organizationId={organizationId} />
      </Suspense>
    )}
  </KnowledgeMemberOnly>
);
