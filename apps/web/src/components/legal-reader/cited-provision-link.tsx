import { useId, useState } from "react";
import type { MouseEvent, ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@stll/ui/preview-card";
import { Skeleton } from "@stll/ui/skeleton";
import { useIsMobile } from "@stll/ui/use-mobile";
import { cn } from "@stll/ui/utils";

import { useInspectorView } from "@/components/inspector/use-inspector-view";
import { LEGAL_CITATION_LINK_CLASS_NAME } from "@/components/legal-reader/citation-link";
import {
  citedProvisionClick,
  CITED_PROVISION_CLICK,
} from "@/components/legal-reader/cited-provision-link.logic";
import { createProvisionViewTab } from "@/features/statutes/provision-inspector.logic";
import type { ProvisionViewPayload } from "@/features/statutes/provision-inspector.logic";
import { provisionPreviewOptions } from "@/features/statutes/queries/provision-preview";
import type { ProvisionPreviewData } from "@/features/statutes/queries/provision-preview";
import { createStatuteLinkTarget } from "@/lib/statute-route";

export type CitedProvisionTarget = {
  /** The consolidation the reference was made against, in the statute reader. */
  document: {
    country: string;
    eli: string | null;
    id: string;
    slug: string | null;
    versionValidFrom: string | null;
  };
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

type ProvisionWordingArgs = {
  documentId: string;
  /** False while nothing is showing the wording, so nothing is read for it. */
  enabled: boolean;
  preview: ProvisionPreviewData | null;
  provision: ProvisionViewPayload;
};

/**
 * The wording one citation points at. The card and the in-place expansion ask
 * under the same key, so unfolding a citation the reader has already hovered
 * costs no second read.
 */
const useProvisionWording = ({
  documentId,
  enabled,
  preview,
  provision,
}: ProvisionWordingArgs) => {
  const { data, isPending } = useQuery({
    ...provisionPreviewOptions({
      anchor: provision.anchorId,
      citedAnchor: provision.highlightAnchorId,
      documentId,
    }),
    enabled: enabled && preview === null,
  });

  return { isPending, wording: preview ?? data };
};

const ProvisionWordingSkeleton = () => (
  <>
    <Skeleton className="h-3 w-full" />
    <Skeleton className="h-3 w-5/6" />
  </>
);

/** The heading trail the provision sits under, then the provision itself. */
const ProvisionWording = ({ wording }: { wording: ProvisionPreviewData }) => (
  <>
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
      className="reader-body text-foreground flex max-h-64 flex-col gap-2 overflow-y-auto text-sm leading-relaxed text-pretty"
      lang={wording.language}
    >
      {wording.blocks.map((block) => (
        <span key={block.id}>{block.text}</span>
      ))}
    </span>
  </>
);

const CitedProvisionPreview = (args: ProvisionWordingArgs) => {
  const { isPending, wording } = useProvisionWording(args);

  if (wording === undefined) {
    if (!isPending) {
      return null;
    }
    return (
      <span className="mt-2 flex flex-col gap-1.5 border-t pt-2">
        <ProvisionWordingSkeleton />
      </span>
    );
  }
  if (wording.blocks.length === 0) {
    return null;
  }

  return (
    <span className="mt-2 flex flex-col gap-1 border-t pt-2">
      <ProvisionWording wording={wording} />
    </span>
  );
};

type CitedProvisionExpansionProps = Omit<ProvisionWordingArgs, "enabled"> & {
  id: string;
  onOpenProvision: () => void;
};

/**
 * The provision unfolded where it is cited: a quiet inset in the paragraph's
 * own flow, not a `<div>` — the decision's blocks are paragraphs, and a block
 * element inside one would close it.
 */
const CitedProvisionExpansion = ({
  id,
  onOpenProvision,
  ...args
}: CitedProvisionExpansionProps) => {
  const t = useTranslations();
  const { isPending, wording } = useProvisionWording({
    ...args,
    enabled: true,
  });
  const hasWording = wording !== undefined && wording.blocks.length > 0;

  return (
    <span
      className="reader-chrome border-border my-2 flex flex-col gap-1.5 border-s ps-3 text-sm"
      id={id}
    >
      {hasWording && <ProvisionWording wording={wording} />}
      {wording === undefined && isPending && <ProvisionWordingSkeleton />}
      <Button
        className="h-6 w-fit px-2"
        onClick={onOpenProvision}
        size="sm"
        variant="outline"
      >
        {t("statutes.openProvision")}
      </Button>
    </span>
  );
};

/**
 * A link from a decision to the provision it applies. Hovering shows the
 * card; a plain click unfolds the wording under the citation, where opening
 * the provision in the inspector is one further, explicit action; a modified
 * click or a mobile tap follows the link into the statute reader.
 */
export const CitedProvisionLink = ({
  children,
  className,
  provision,
}: CitedProvisionLinkProps) => {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const isMobile = useIsMobile();
  const inspector = useInspectorView();
  const expansionId = useId();
  const expandsInPlace = !isMobile;

  const onProvisionClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const click = citedProvisionClick({
      expanded,
      expandsInPlace,
      gesture: event,
    });
    switch (click) {
      case CITED_PROVISION_CLICK.navigate:
        break;
      case CITED_PROVISION_CLICK.expand:
        event.preventDefault();
        setExpanded(true);
        break;
      case CITED_PROVISION_CLICK.collapse:
        event.preventDefault();
        setExpanded(false);
        break;
      default:
        click satisfies never;
        panic(`Unhandled cited-provision click: ${String(click)}`);
    }
  };

  return (
    <>
      {/* The card is the hover reading; while the same wording stands
          unfolded in the text, it would only cover it. */}
      <PreviewCard
        onOpenChange={setPreviewOpen}
        open={previewOpen && !expanded}
      >
        <PreviewCardTrigger
          render={
            <Link
              aria-controls={expanded ? expansionId : undefined}
              aria-expanded={expandsInPlace ? expanded : undefined}
              className={cn(LEGAL_CITATION_LINK_CLASS_NAME, className)}
              hash={
                provision.payload.highlightAnchorId ??
                provision.payload.anchorId
              }
              onClick={onProvisionClick}
              {...createStatuteLinkTarget({
                country: provision.document.country,
                documentId: provision.document.id,
                eli: provision.document.eli,
                slug: provision.document.slug,
                versionValidFrom: provision.document.versionValidFrom,
              })}
            />
          }
        >
          {children}
        </PreviewCardTrigger>
        <PreviewCardPopup className="reader-chrome w-[min(32rem,calc(100vw-2rem))] max-w-none flex-col gap-0.5 p-3">
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
            enabled={previewOpen}
            preview={provision.preview}
            provision={provision.payload}
          />
        </PreviewCardPopup>
      </PreviewCard>
      {expanded && (
        <CitedProvisionExpansion
          documentId={provision.document.id}
          id={expansionId}
          onOpenProvision={() =>
            inspector.open(createProvisionViewTab(provision.payload))
          }
          preview={provision.preview}
          provision={provision.payload}
        />
      )}
    </>
  );
};
