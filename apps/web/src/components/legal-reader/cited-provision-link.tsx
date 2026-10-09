import { useState } from "react";
import type { MouseEvent, ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { panic, Result } from "better-result";

import { LEGAL_CITATION_LINK_CLASS_NAME } from "@stll/decision-reader/citation-link";
import {
  CitedProvisionExpansion as ProvisionExpansion,
  CitedProvisionLink as ProvisionLink,
} from "@stll/decision-reader/cited-provision";
import { useReaderAdapters } from "@stll/decision-reader/reader-adapters";
import type { ProvisionWordingVersion } from "@stll/decision-reader/reader-adapters";
import type {
  CitedProvisionTarget,
  ProvisionPreviewData,
  ProvisionViewPayload,
} from "@stll/decision-reader/reader-types";
import { cn } from "@stll/ui/utils";

import {
  citedProvisionClick,
  CITED_PROVISION_CLICK,
} from "@/components/legal-reader/cited-provision-link.logic";
import { provisionPreviewOptions } from "@/features/statutes/queries/provision-preview";
import { detached } from "@/lib/detached";
import { createStatuteLinkTarget } from "@/lib/statute-route";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";

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

export const CitedProvisionExpansion = ({
  label,
  provision,
  version,
}: {
  label: string;
  provision: CitedProvisionTarget;
  version: ProvisionWordingVersion;
}) => {
  const state = useProvisionWording({
    documentId: provision.document.id,
    enabled: true,
    preview: provision.preview,
    provision: provision.payload,
  });
  return (
    <ProvisionExpansion
      label={label}
      provision={provision}
      version={version}
      {...state}
    />
  );
};

export const CitedProvisionLink = ({
  children,
  className,
  provision,
}: {
  children: ReactNode;
  className?: string | undefined;
  provision: CitedProvisionTarget;
}) => {
  const [previewOpen, setPreviewOpen] = useState(false);
  const { loadProvisionPreview } = useReaderAdapters();
  const onPreviewOpenChange = (open: boolean) => {
    setPreviewOpen(open);
    if (!open || provision.preview !== null) {
      return;
    }
    // The Query observer below owns preview failures; the demand read shares
    // its cache entry and must not report the same failure a second time.
    detached(
      Result.tryPromise(
        async () =>
          await loadProvisionPreview({
            anchor: provision.payload.anchorId,
            citedAnchor: provision.payload.highlightAnchorId,
            documentId: provision.document.id,
          }),
      ),
      "legal-reader.provision-preview",
    );
  };
  const state = useProvisionWording({
    documentId: provision.document.id,
    enabled: previewOpen,
    preview: provision.preview,
    provision: provision.payload,
  });
  const onProvisionClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const click = citedProvisionClick(event);
    switch (click) {
      case CITED_PROVISION_CLICK.navigate:
        break;
      case CITED_PROVISION_CLICK.peek:
        event.preventDefault();
        onPreviewOpenChange(true);
        break;
      default:
        click satisfies never;
        panic(`Unhandled cited-provision click: ${String(click)}`);
    }
  };
  const link = (
    <Link
      aria-expanded={previewOpen}
      className={cn(LEGAL_CITATION_LINK_CLASS_NAME, className)}
      hash={provision.payload.highlightAnchorId ?? provision.payload.anchorId}
      onClick={onProvisionClick}
      {...createStatuteLinkTarget({
        country: provision.document.country,
        documentId: provision.document.id,
        eli: provision.document.eli,
        slug: provision.document.slug,
        versionValidFrom: provision.document.versionValidFrom,
      })}
    />
  );
  return (
    <ProvisionLink
      provision={provision}
      previewOpen={previewOpen}
      onPreviewOpenChange={onPreviewOpenChange}
      link={link}
      {...state}
    >
      {children}
    </ProvisionLink>
  );
};
