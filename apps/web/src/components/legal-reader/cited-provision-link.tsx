import { useState } from "react";
import type { MouseEvent, ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import { useFormatter, useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { PanelRightIcon } from "@stll/ui/icons";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@stll/ui/preview-card";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { useInspectorView } from "@/components/inspector/use-inspector-view";
import { LEGAL_CITATION_LINK_CLASS_NAME } from "@/components/legal-reader/citation-link";
import {
  citedProvisionClick,
  CITED_PROVISION_CLICK,
  informativeProvisionTrail,
} from "@/components/legal-reader/cited-provision-link.logic";
import { ReaderInsetBox } from "@/components/legal-reader/reader-inset-box";
import { createProvisionViewTab } from "@/features/statutes/provision-inspector.logic";
import type { ProvisionViewPayload } from "@/features/statutes/provision-inspector.logic";
import { provisionPreviewOptions } from "@/features/statutes/queries/provision-preview";
import type { ProvisionPreviewData } from "@/features/statutes/queries/provision-preview";
import { formatValidityDate } from "@/features/statutes/statute-format";
import { createStatuteLinkTarget } from "@/lib/statute-route";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";

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
 * The wording one citation points at. The preview and the paragraph card ask
 * under the same key, so unfolding a citation the reader has already hovered
 * costs no second read.
 */
const useProvisionWording = ({
  documentId,
  enabled,
  preview,
  provision,
}: ProvisionWordingArgs) => {
  const dataQuery = useQuery({
    ...provisionPreviewOptions({
      anchor: provision.anchorId,
      citedAnchor: provision.highlightAnchorId,
      documentId,
    }),
    enabled: enabled && preview === null,
  });
  const dataView = useQueryView(dataQuery);
  useQueryViewError(dataView);
  const { isPending } = dataQuery;
  const data = dataView.type === "items" ? dataView.items : undefined;

  return { isPending, wording: preview ?? data };
};

const ProvisionWordingSkeleton = () => (
  <span className="flex flex-col gap-1.5" data-slot="provision-card-pending">
    <Skeleton className="h-3 w-full" />
    <Skeleton className="h-3 w-5/6" />
  </span>
);

const OpenCitedProvisionButton = ({
  provision,
}: {
  provision: ProvisionViewPayload;
}) => {
  const t = useTranslations();
  const inspector = useInspectorView();
  return (
    <Button
      aria-label={t("statutes.openProvision")}
      className="ms-auto shrink-0"
      onClick={() => inspector.open(createProvisionViewTab(provision))}
      size="icon-xs"
      variant="ghost"
    >
      <PanelRightIcon aria-hidden="true" className="size-3.5" />
    </Button>
  );
};

type ProvisionCardBody =
  | { type: "pending" }
  | { type: "unavailable" }
  | { type: "wording"; wording: ProvisionPreviewData };

/**
 * What a card shows under its row. A failed read, a version that does not
 * carry the provision, and a provision with no text in it all say that the
 * text is not available rather than leaving the card empty.
 */
const provisionCardBody = ({
  isPending,
  wording,
}: {
  isPending: boolean;
  wording: ProvisionPreviewData | null | undefined;
}): ProvisionCardBody => {
  if (wording === undefined) {
    return isPending ? { type: "pending" } : { type: "unavailable" };
  }
  if (wording === null || wording.blocks.length === 0) {
    return { type: "unavailable" };
  }
  return { type: "wording", wording };
};

const ProvisionCardWording = ({ body }: { body: ProvisionCardBody }) => {
  const t = useTranslations();
  switch (body.type) {
    case "pending":
      return <ProvisionWordingSkeleton />;
    case "unavailable":
      return (
        <span
          className="reader-chrome text-muted-foreground text-xs"
          data-slot="provision-card-unavailable"
        >
          {t("statutes.provisionTextUnavailable")}
        </span>
      );
    case "wording":
      return (
        <span
          className="reader-body text-foreground flex max-h-64 flex-col gap-2 overflow-y-auto text-sm leading-relaxed text-pretty"
          lang={body.wording.language}
        >
          {body.wording.blocks.map((block) => (
            <span key={block.id}>{block.text}</span>
          ))}
        </span>
      );
    default:
      body satisfies never;
      return panic("Unhandled provision card body");
  }
};

type CitedProvisionCardProps = {
  /** False while nothing shows the card, so nothing is read for it. */
  enabled: boolean;
  /** What the reader calls the provision: the citation as written. */
  label: string;
  provision: CitedProvisionTarget;
};

/**
 * One cited provision, compact: a single row naming it, dating the wording
 * and opening it, then where it sits when the label does not already say so,
 * then its wording. A version that does not carry the provision says so
 * rather than drawing an empty card. Every surface that shows a cited
 * provision's wording, inline or peeked, draws this.
 */
const CitedProvisionCard = ({
  enabled,
  label,
  provision,
}: CitedProvisionCardProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const { isPending, wording } = useProvisionWording({
    documentId: provision.document.id,
    enabled,
    preview: provision.preview,
    provision: provision.payload,
  });
  const date = formatValidityDate(provision.document.versionValidFrom, format);
  const trail = informativeProvisionTrail({
    label,
    places: [
      provision.payload.statuteTitle,
      ...(wording?.headings.map(({ text }) => text) ?? []),
    ],
  });
  const body = provisionCardBody({ isPending, wording });

  return (
    <>
      <span
        className="reader-chrome flex min-w-0 items-center gap-1.5"
        data-slot="provision-card-header"
      >
        <BidiText as="span" className="min-w-0 truncate text-sm font-medium">
          {label}
        </BidiText>
        <span aria-hidden="true" className="text-muted-foreground text-xs">
          ·
        </span>
        <span className="text-muted-foreground shrink-0 text-xs">
          {date === null
            ? t("statutes.wordingVersionUnknown")
            : t("statutes.inForceSince", { date })}
        </span>
        <OpenCitedProvisionButton provision={provision.payload} />
      </span>
      {trail.length > 0 && (
        <BidiText
          as="span"
          className="reader-chrome text-muted-foreground truncate text-xs"
          lang={wording?.language}
        >
          {trail.join(" › ")}
        </BidiText>
      )}
      <ProvisionCardWording body={body} />
    </>
  );
};

/** Rendered by the paragraph owner, never by its inline citation link. */
export const CitedProvisionExpansion = ({
  label,
  provision,
}: {
  label: string;
  provision: CitedProvisionTarget;
}) => (
  <ReaderInsetBox
    className="my-2 flex flex-col gap-1.5 px-3 py-2"
    data-reader-chrome=""
    data-slot="provision-card"
  >
    <CitedProvisionCard enabled label={label} provision={provision} />
  </ReaderInsetBox>
);

/** Hover or a plain click peeks at wording without interrupting the sentence. */
export const CitedProvisionLink = ({
  children,
  className,
  provision,
}: CitedProvisionLinkProps) => {
  const [previewOpen, setPreviewOpen] = useState(false);

  const onProvisionClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const click = citedProvisionClick(event);
    switch (click) {
      case CITED_PROVISION_CLICK.navigate:
        break;
      case CITED_PROVISION_CLICK.peek:
        event.preventDefault();
        setPreviewOpen(true);
        break;
      default:
        click satisfies never;
        panic(`Unhandled cited-provision click: ${String(click)}`);
    }
  };

  return (
    <PreviewCard onOpenChange={setPreviewOpen} open={previewOpen}>
      <PreviewCardTrigger
        render={
          <Link
            aria-expanded={previewOpen}
            className={cn(LEGAL_CITATION_LINK_CLASS_NAME, className)}
            hash={
              provision.payload.highlightAnchorId ?? provision.payload.anchorId
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
      <PreviewCardPopup className="reader-chrome w-[min(32rem,calc(100vw-2rem))] max-w-none flex-col gap-1.5 p-3">
        <CitedProvisionCard
          enabled={previewOpen}
          label={provision.payload.provisionLabel}
          provision={provision}
        />
      </PreviewCardPopup>
    </PreviewCard>
  );
};
