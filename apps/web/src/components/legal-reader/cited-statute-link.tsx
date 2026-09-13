import type { ReactNode } from "react";

import { Link } from "@tanstack/react-router";

import { BidiText } from "@stll/ui/bidi-text";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@stll/ui/preview-card";
import { cn } from "@stll/ui/utils";

import { LEGAL_CITATION_LINK_CLASS_NAME } from "@/components/legal-reader/citation-link";
import { createStatuteLinkTarget } from "@/lib/statute-route";

export type CitedStatuteTarget = {
  document: {
    country: string;
    eli?: string | null;
    id: string;
    slug?: string | null;
    versionValidFrom?: string | null;
  };
  statuteTitle: string;
};

/** A work-level statute citation: no provision locator is required. */
export const CitedStatuteLink = ({
  children,
  className,
  target,
}: {
  children: ReactNode;
  className?: string | undefined;
  target: CitedStatuteTarget;
}) => (
  <PreviewCard>
    <PreviewCardTrigger
      render={
        <Link
          className={cn(LEGAL_CITATION_LINK_CLASS_NAME, className)}
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
    <PreviewCardPopup className="w-auto max-w-80 p-3 font-sans">
      <BidiText as="span" className="text-foreground text-sm font-medium">
        {target.statuteTitle}
      </BidiText>
    </PreviewCardPopup>
  </PreviewCard>
);
