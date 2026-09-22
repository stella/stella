/**
 * The one action that opens a listed statute beside the results, the way a
 * listed decision opens: the row, its Enter and its title link all go through
 * it. Where there is no beside (the public inspector dock is not rendered
 * below `md`), the act's own page opens instead.
 */

import type { MouseEvent } from "react";

import { useNavigate } from "@tanstack/react-router";

import { useIsMobile } from "@stll/ui/use-mobile";

import { opensCitationInInspector } from "@/components/inspector/case-decision-view";
import { useInspectorView } from "@/components/inspector/use-inspector-view";
import type { StatuteListItem } from "@/features/statutes/queries/statutes";
import { createStatuteViewTab } from "@/features/statutes/statute-inspector.logic";
import { detached } from "@/lib/detached";
import { createStatuteRouteParams } from "@/lib/statute-route";

/** The page a listed statute opens on: the act's canonical address. */
export const statuteListLinkTarget = (statute: StatuteListItem) => {
  const { country, slug } = createStatuteRouteParams({
    country: statute.country,
    documentId: statute.id,
    eli: statute.eli,
    slug: statute.slug,
  });
  return {
    params: { country, slug },
    to: "/law/$country/statutes/$slug",
  } as const;
};

export const useOpenStatuteTab = () => {
  const { open: openView } = useInspectorView();
  const navigate = useNavigate();
  const inspectorAvailable = !useIsMobile();

  const openInInspector = (statute: StatuteListItem) => {
    openView(
      createStatuteViewTab({
        country: statute.country,
        documentId: statute.id,
        eli: statute.eli,
        slug: statute.slug,
        statuteTitle: statute.title,
        versionValidFrom: statute.versionValidFrom,
      }),
    );
  };

  return {
    /** The row's own gesture: a click or Enter, with no href to fall back to. */
    open: (statute: StatuteListItem) => {
      if (inspectorAvailable) {
        openInInspector(statute);
        return;
      }
      detached(
        navigate(statuteListLinkTarget(statute)),
        "statutes.open-statute-page",
      );
    },
    /**
     * The title link's click, which opens what the row opens. Every browser
     * navigation gesture (middle click, ⌘/Ctrl click, "open in new tab") is
     * left alone and follows the href to the act's page.
     */
    onLinkClick:
      (statute: StatuteListItem) => (event: MouseEvent<HTMLAnchorElement>) => {
        if (!opensCitationInInspector(event, inspectorAvailable)) {
          return;
        }
        event.preventDefault();
        openInInspector(statute);
      },
  };
};
