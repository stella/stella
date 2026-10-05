import { useState } from "react";
import type { MouseEvent, ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import { useFormatter, useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
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
} from "@/components/legal-reader/cited-provision-link.logic";
import { ReaderInsetBox } from "@/components/legal-reader/reader-inset-box";
import { createProvisionViewTab } from "@/features/statutes/provision-inspector.logic";
import type { ProvisionViewPayload } from "@/features/statutes/provision-inspector.logic";
import { provisionPreviewOptions } from "@/features/statutes/queries/provision-preview";
import type { ProvisionPreviewData } from "@/features/statutes/queries/provision-preview";
import { formatValidityDate } from "@/features/statutes/statute-format";
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

type ProvisionWordingVersion =
  | { type: "current" }
  | { type: "consolidation"; validFrom: string | null };

const ProvisionVersionLabel = ({
  version,
}: {
  version: ProvisionWordingVersion;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  switch (version.type) {
    case "current":
      return (
        <span className="reader-chrome text-muted-foreground text-xs">
          {t("statutes.currentWording")}
        </span>
      );
    case "consolidation": {
      const date = formatValidityDate(version.validFrom, format);
      return (
        <span className="reader-chrome text-muted-foreground text-xs">
          {date === null
            ? t("statutes.wordingVersionUnknown")
            : t("statutes.wordingValidFrom", { date })}
        </span>
      );
    }
    default:
      version satisfies never;
      return panic("Unhandled provision wording version");
  }
};

const OpenCitedProvisionButton = ({
  provision,
}: {
  provision: ProvisionViewPayload;
}) => {
  const t = useTranslations();
  const inspector = useInspectorView();
  return (
    <span className="reader-chrome">
      <Button
        className="w-fit"
        onClick={() => inspector.open(createProvisionViewTab(provision))}
        size="xs"
        variant="outline"
      >
        {t("statutes.openProvision")}
      </Button>
    </span>
  );
};

/** Rendered by the paragraph owner, never by its inline citation link. */
export const CitedProvisionExpansion = ({
  label,
  provision,
  version,
}: {
  label: string;
  provision: CitedProvisionTarget;
  version: ProvisionWordingVersion;
}) => {
  const { isPending, wording } = useProvisionWording({
    documentId: provision.document.id,
    enabled: true,
    preview: provision.preview,
    provision: provision.payload,
  });

  return (
    <ReaderInsetBox
      className="my-3 flex flex-col gap-2"
      data-reader-chrome=""
      data-slot="provision-card"
    >
      <span className="reader-chrome">
        <BidiText as="span" className="text-sm font-medium">
          {label}
        </BidiText>
      </span>
      <ProvisionVersionLabel version={version} />
      {wording !== undefined && wording.blocks.length > 0 && (
        <ProvisionWording wording={wording} />
      )}
      {wording === undefined && isPending && <ProvisionWordingSkeleton />}
      <OpenCitedProvisionButton provision={provision.payload} />
    </ReaderInsetBox>
  );
};

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
      <PreviewCardPopup className="reader-chrome w-[min(32rem,calc(100vw-2rem))] max-w-none flex-col gap-0.5 p-3">
        <BidiText as="span" className="text-foreground text-sm font-medium">
          {provision.payload.provisionLabel}
        </BidiText>
        {provision.payload.statuteTitle !== "" && (
          <span className="text-muted-foreground text-xs">
            {provision.payload.statuteTitle}
          </span>
        )}
        <ProvisionVersionLabel
          version={{
            type: "consolidation",
            validFrom: provision.document.versionValidFrom,
          }}
        />
        <CitedProvisionPreview
          documentId={provision.document.id}
          enabled={previewOpen}
          preview={provision.preview}
          provision={provision.payload}
        />
        <OpenCitedProvisionButton provision={provision.payload} />
      </PreviewCardPopup>
    </PreviewCard>
  );
};
