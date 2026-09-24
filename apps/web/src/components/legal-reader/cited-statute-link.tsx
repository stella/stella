import type { MouseEvent, ReactNode } from "react";

import { Link } from "@tanstack/react-router";

import { BidiText } from "@stll/ui/bidi-text";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@stll/ui/preview-card";
import { useIsMobile } from "@stll/ui/use-mobile";
import { cn } from "@stll/ui/utils";

import { opensCitationInInspector } from "@/components/inspector/case-decision-view";
import { useInspectorView } from "@/components/inspector/use-inspector-view";
import { LEGAL_CITATION_LINK_CLASS_NAME } from "@/components/legal-reader/citation-link";
import { createStatuteViewTab } from "@/features/statutes/statute-inspector.logic";
import { createStatuteLinkTarget } from "@/lib/statute-route";

/** A work-level statute citation: the consolidation it resolved to, named. */
export type CitedStatuteTarget = {
  document: {
    country: string;
    eli: string | null;
    id: string;
    slug: string | null;
    versionValidFrom: string | null;
  };
  statuteTitle: string;
};

/**
 * A work-level statute citation: no provision locator is required.
 *
 * A plain click opens the act beside the decision, the way a cited decision
 * opens beside the results. Every browser navigation gesture, and a phone,
 * where there is no beside to open into, follows the link to the act's own
 * page instead.
 */
export const CitedStatuteLink = ({
  children,
  className,
  target,
}: {
  children: ReactNode;
  className?: string | undefined;
  target: CitedStatuteTarget;
}) => {
  const inspectorAvailable = !useIsMobile();
  const { open } = useInspectorView();

  const onStatuteClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!opensCitationInInspector(event, inspectorAvailable)) {
      return;
    }
    event.preventDefault();
    open(
      createStatuteViewTab({
        country: target.document.country,
        documentId: target.document.id,
        eli: target.document.eli,
        slug: target.document.slug,
        statuteTitle: target.statuteTitle,
        versionValidFrom: target.document.versionValidFrom,
      }),
    );
  };

  return (
    <PreviewCard>
      <PreviewCardTrigger
        render={
          <Link
            className={cn(LEGAL_CITATION_LINK_CLASS_NAME, className)}
            onClick={onStatuteClick}
            {...createStatuteLinkTarget({
              country: target.document.country,
              documentId: target.document.id,
              eli: target.document.eli,
              slug: target.document.slug,
              versionValidFrom: target.document.versionValidFrom,
            })}
          />
        }
      >
        {children}
      </PreviewCardTrigger>
      <PreviewCardPopup className="reader-chrome w-auto max-w-80 p-3">
        <BidiText as="span" className="text-foreground text-sm font-medium">
          {target.statuteTitle}
        </BidiText>
      </PreviewCardPopup>
    </PreviewCard>
  );
};
