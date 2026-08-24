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
import { createProvisionViewTab } from "@/features/statutes/provision-inspector.logic";
import type { ProvisionViewPayload } from "@/features/statutes/provision-inspector.logic";
import { toStatuteCountrySegment } from "@/lib/statute-route";

export type CitedProvisionTarget = {
  /** The consolidation the reference was made against, in the statute reader. */
  document: { country: string; id: string };
  payload: ProvisionViewPayload;
};

type CitedProvisionLinkProps = {
  children: ReactNode;
  className?: string | undefined;
  provision: CitedProvisionTarget;
};

/**
 * A link from a decision to the provision it applies. A plain click opens the
 * provision in the inspector beside the text; a modified click or a mobile
 * tap follows the link into the statute reader at that provision.
 */
export const CitedProvisionLink = ({
  children,
  className,
  provision,
}: CitedProvisionLinkProps) => {
  const isMobile = useIsMobile();
  const inspector = useInspectorView();
  const onProvisionClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!opensCitationInInspector(event, !isMobile)) {
      return;
    }

    event.preventDefault();
    inspector.open(createProvisionViewTab(provision.payload));
  };

  return (
    <PreviewCard>
      <PreviewCardTrigger
        render={
          <Link
            className={cn(
              "text-primary decoration-primary/40 underline underline-offset-2 hover:decoration-current",
              className,
            )}
            hash={provision.payload.anchorId}
            onClick={onProvisionClick}
            params={{
              country: toStatuteCountrySegment(provision.document.country),
              documentId: provision.document.id,
            }}
            to="/law/$country/statutes/$documentId"
          />
        }
      >
        {children}
      </PreviewCardTrigger>
      <PreviewCardPopup className="w-auto max-w-72 flex-col gap-0.5 p-3 font-sans">
        <BidiText as="span" className="text-foreground text-sm font-medium">
          {provision.payload.provisionLabel}
        </BidiText>
        {provision.payload.statuteTitle !== "" && (
          <span className="text-muted-foreground text-xs">
            {provision.payload.statuteTitle}
          </span>
        )}
      </PreviewCardPopup>
    </PreviewCard>
  );
};
