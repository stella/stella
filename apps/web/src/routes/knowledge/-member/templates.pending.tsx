import {
  TEMPLATE_LIST_LAYOUT,
  TemplateListPending,
} from "@/features/knowledge/views/templates/template-list-shape";
import type { TemplateDensity } from "@/features/knowledge/views/templates/templates-seam";
import { framePendingView } from "@/routes/-pending-view.logic";

/** The organization's template library before its templates arrive, at the
 *  reader's density where the page knows it. */
export const TemplatesLibraryPending = ({
  density,
}: {
  density?: TemplateDensity | undefined;
}) => (
  <TemplateListPending
    density={density}
    layout={TEMPLATE_LIST_LAYOUT.library}
  />
);

/** The template library while the page loads. */
export const TemplatesPending = framePendingView(() => (
  <TemplatesLibraryPending />
));
