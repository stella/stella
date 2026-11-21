import { usePendingCache } from "@/components/pending-cache";
import {
  TEMPLATE_LIST_LAYOUT,
  TemplateListPending,
} from "@/features/knowledge/views/templates/template-list-shape";
import type { TemplateDensity } from "@/features/knowledge/views/templates/templates-seam";
import { cachedRoleGrants } from "@/lib/organization/cached-permissions.logic";
import { framePendingView } from "@/routes/-pending-view.logic";

/** The organization's template library before its templates arrive, at the
 *  reader's density where the page knows it, with the create actions where
 *  the cached role grants them. */
export const TemplatesLibraryPending = ({
  density,
}: {
  density?: TemplateDensity | undefined;
}) => {
  const cache = usePendingCache();
  return (
    <TemplateListPending
      canCreate={
        cache !== null && cachedRoleGrants(cache, { template: ["create"] })
      }
      density={density}
      layout={TEMPLATE_LIST_LAYOUT.library}
    />
  );
};

/** The template library while the page loads. */
export const TemplatesPending = framePendingView(() => (
  <TemplatesLibraryPending />
));
