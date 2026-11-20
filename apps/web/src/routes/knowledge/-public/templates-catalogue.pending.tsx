import type { ReactNode } from "react";

import {
  TEMPLATE_LIST_LAYOUT,
  TemplateListPending,
} from "@/features/knowledge/views/templates/template-list-shape";
import { framePendingView } from "@/routes/-pending-view.logic";

/** The column the published template list fills. */
export const TemplatesCatalogueShell = ({
  children,
}: {
  children: ReactNode;
}) => <div className="flex min-h-0 flex-1 flex-col">{children}</div>;

/** The published templates while they load: the list's own pending phase. */
export const TemplatesCataloguePending = framePendingView(() => (
  <TemplatesCatalogueShell>
    <TemplateListPending layout={TEMPLATE_LIST_LAYOUT.catalogue} />
  </TemplatesCatalogueShell>
));
