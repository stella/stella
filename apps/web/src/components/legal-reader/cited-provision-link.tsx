import { useState } from "react";
import type { MouseEvent, ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { BidiText } from "@stll/ui/bidi-text";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@stll/ui/preview-card";
import { Skeleton } from "@stll/ui/skeleton";
import { useIsMobile } from "@stll/ui/use-mobile";
import { cn } from "@stll/ui/utils";

import { opensCitationInInspector } from "@/components/inspector/case-decision-view";
import { useInspectorView } from "@/components/inspector/use-inspector-view";
import { LEGAL_CITATION_LINK_CLASS_NAME } from "@/components/legal-reader/citation-link";
import { createProvisionViewTab } from "@/features/statutes/provision-inspector.logic";
import type { ProvisionViewPayload } from "@/features/statutes/provision-inspector.logic";
import { provisionPreviewOptions } from "@/features/statutes/queries/provision-preview";
import type { ProvisionPreviewData } from "@/features/statutes/queries/provision-preview";
import { toStatuteCountrySegment } from "@/lib/statute-route";

export type CitedProvisionTarget = {
  /** The consolidation the reference was made against, in the statute reader. */
  document: { country: string; id: string };
  payload: ProvisionViewPayload;
  /**
   * The wording the reference's own list already carried, when it did. A
   * target without one reads its provision when the card opens.
   */
  preview: ProvisionPreviewData | null;
};

type CitedProvisionLinkProps = {
  children: ReactNode;
  className?: string | undefined;
  provision: CitedProvisionTarget;
};

const CitedProvisionPreview = ({
  documentId,
  open,
  preview,
  provision,
}: {
  documentId: string;
  open: boolean;
  preview: ProvisionPreviewData | null;
  provision: ProvisionViewPayload;
}) => {
  const { data: read, isPending } = useQuery({
    ...provisionPreviewOptions({
      anchor: provision.anchorId,
      citedAnchor: provision.highlightAnchorId,
      documentId,
    }),
    enabled: open && preview === null,
  });
  const wording = preview ?? read;

  if (wording === undefined && isPending) {
    return (
      <span className="mt-2 flex flex-col gap-1.5 border-t pt-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
      </span>
    );
  }
  if (wording === undefined || wording.blocks.length === 0) {
    return null;
  }

  return (
    <span className="mt-2 flex flex-col gap-1 border-t pt-2">
      {wording.headings.length > 0 && (
        <BidiText
          as="span"
          className="text-muted-foreground truncate text-xs"
          lang={wording.language}
        >
          {wording.headings.map(({ text }) => text).join(" › ")}
        </BidiText>
      )}
      <span
        className="text-foreground flex max-h-64 flex-col gap-2 overflow-y-auto font-serif text-sm leading-relaxed text-pretty"
        lang={wording.language}
      >
        {wording.blocks.map((block) => (
          <span key={block.id}>{block.text}</span>
        ))}
      </span>
    </span>
  );
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
  const [previewOpen, setPreviewOpen] = useState(false);
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
    <PreviewCard onOpenChange={setPreviewOpen} open={previewOpen}>
      <PreviewCardTrigger
        render={
          <Link
            className={cn(LEGAL_CITATION_LINK_CLASS_NAME, className)}
            hash={
              provision.payload.highlightAnchorId ?? provision.payload.anchorId
            }
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
      <PreviewCardPopup className="w-[min(32rem,calc(100vw-2rem))] max-w-none flex-col gap-0.5 p-3 font-sans">
        <BidiText as="span" className="text-foreground text-sm font-medium">
          {provision.payload.provisionLabel}
        </BidiText>
        {provision.payload.statuteTitle !== "" && (
          <span className="text-muted-foreground text-xs">
            {provision.payload.statuteTitle}
          </span>
        )}
        <CitedProvisionPreview
          documentId={provision.document.id}
          open={previewOpen}
          preview={provision.preview}
          provision={provision.payload}
        />
      </PreviewCardPopup>
    </PreviewCard>
  );
};
