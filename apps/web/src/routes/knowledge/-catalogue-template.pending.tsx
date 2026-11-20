import type { ReactNode } from "react";

import { TemplateCatalogueDetailPending } from "@/features/knowledge/views/templates/template-catalogue-detail-view.pending";
import { framePendingView } from "@/routes/-pending-view.logic";

/** The column a catalogue template's page fills. */
export const CatalogueTemplateShell = ({
  children,
}: {
  children: ReactNode;
}) => <div className="flex min-h-0 flex-1 flex-col">{children}</div>;

/** A catalogue template's page before the template has been read. */
export const CatalogueTemplatePending = framePendingView(() => (
  <CatalogueTemplateShell>
    <TemplateCatalogueDetailPending />
  </CatalogueTemplateShell>
));
