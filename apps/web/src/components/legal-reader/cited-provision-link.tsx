import { useState } from "react";
import type { MouseEvent, ReactNode } from "react";

import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { panic, Result } from "better-result";

import { LEGAL_CITATION_LINK_CLASS_NAME } from "@stll/decision-reader/citation-link";
import {
  CitedProvisionExpansion as ProvisionExpansion,
  CitedProvisionLink as ProvisionLink,
} from "@stll/decision-reader/cited-provision";
import type { FullProvisionRead } from "@stll/decision-reader/cited-provision";
import type { CitedWording } from "@stll/decision-reader/provision-card.logic";
import { useReaderAdapters } from "@stll/decision-reader/reader-adapters";
import type { CitedProvisionTarget } from "@stll/decision-reader/reader-types";
import { cn } from "@stll/ui/utils";

import {
  citedProvisionClick,
  CITED_PROVISION_CLICK,
} from "@/components/legal-reader/cited-provision-link.logic";
import {
  keepReadingPosition,
  readerScrollOwner,
} from "@/components/legal-reader/reader-position";
import {
  provisionInVersionOptions,
  provisionPreviewOptions,
} from "@/features/statutes/queries/provision-preview";
import { detached } from "@/lib/detached";
import { queryView } from "@/lib/query-view.logic";
import { createStatuteLinkTarget } from "@/lib/statute-route";
import {
  useQueryView,
  useQueryViewError,
  useQueryViewErrors,
} from "@/lib/use-query-view";

const citationPreviewOptions = ({ document, payload }: CitedProvisionTarget) =>
  provisionPreviewOptions({
    anchor: payload.anchorId,
    citedAnchor: payload.highlightAnchorId,
    documentId: document.id,
  });

type CitedWordingsArgs = {
  citations: readonly CitedProvisionTarget[];
  /** False while nothing is showing the wording, so nothing is read for it. */
  enabled: boolean;
};

/**
 * The wording each citation points at: the one the decision's list carried,
 * or a read of its own. The hover card and the paragraph card ask under the
 * same key, so unfolding a citation the reader has already hovered costs no
 * second read. A read that failed or found nothing answers null.
 */
const useCitedWordings = ({
  citations,
  enabled,
}: CitedWordingsArgs): CitedWording[] => {
  const reads = useQueries({
    queries: citations.map((target) => ({
      ...citationPreviewOptions(target),
      enabled: enabled && target.preview === null,
    })),
  });
  const views = reads.map((read) => queryView(read));
  useQueryViewErrors(views);
  return citations.map((target, index) => {
    if (target.preview !== null) {
      return { target, wording: target.preview };
    }
    const view = views.at(index) ?? panic("A citation without its read");
    switch (view.type) {
      case "items":
        return { target, wording: view.items };
      case "pending":
        return { target, wording: undefined };
      case "empty":
      case "error":
        return { target, wording: null };
      default:
        view satisfies never;
        return panic("Unhandled provision wording read");
    }
  });
};

type FullProvisionArgs = {
  first: CitedProvisionTarget;
  /** False until the reader asks for the whole provision. */
  enabled: boolean;
};

/** The whole provision around the cited parts, read when the reader asks. */
const useFullProvision = ({
  enabled,
  first,
}: FullProvisionArgs): FullProvisionRead => {
  const read = useQuery({
    ...provisionInVersionOptions({
      anchor: first.payload.anchorId,
      documentId: first.document.id,
    }),
    enabled,
  });
  const view = useQueryView(read);
  useQueryViewError(view);
  return {
    isPending: view.type === "pending",
    whole: view.type === "items" ? view.items : null,
  };
};

const FULL_PROVISION = { cited: "cited", full: "full" } as const;
type FullProvisionState = keyof typeof FULL_PROVISION;

/**
 * One cited provision under the paragraph that cites it. Every citation of
 * the provision in the paragraph shares the card.
 */
export const CitedProvisionExpansion = ({
  citations,
}: {
  citations: readonly CitedProvisionTarget[];
}) => {
  const [shown, setShown] = useState<FullProvisionState>(FULL_PROVISION.cited);
  const first = citations.at(0) ?? panic("A provision card without citations");
  const wordings = useCitedWordings({ citations, enabled: true });
  const full = useFullProvision({
    enabled: shown === FULL_PROVISION.full,
    first,
  });

  const onToggleFull = (event: MouseEvent<HTMLButtonElement>) => {
    const toggle = event.currentTarget;
    keepReadingPosition(
      { anchor: toggle, scroller: readerScrollOwner(toggle) },
      () => {
        setShown((current) =>
          current === FULL_PROVISION.full
            ? FULL_PROVISION.cited
            : FULL_PROVISION.full,
        );
      },
    );
  };

  return (
    <ProvisionExpansion
      citations={citations}
      full={full}
      onToggleFull={onToggleFull}
      showsFull={shown === FULL_PROVISION.full}
      wordings={wordings}
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
  const wordings = useCitedWordings({
    citations: [provision],
    enabled: previewOpen,
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
      wordings={wordings}
    >
      {children}
    </ProvisionLink>
  );
};
