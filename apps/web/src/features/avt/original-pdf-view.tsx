import * as React from "react";
/**
 * The verified PDF in the file viewer, read-only, with the run's claims
 * drawn as boxes over the words they were anchored on, in their verdict's
 * mark, and selectable by click.
 *
 * The boxes come from the same text extraction the server ran (see
 * `original-pdf.logic.ts`), read off the main thread for the pages that
 * carry claims. Claims with no place on the pages are listed under them so
 * they stay one click away.
 */

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { textMarkBoxClass } from "@stll/ui/text-mark";
import { cn } from "@stll/ui/utils";

import { InspectorPdfErrorFallback } from "@/components/inspector/inspector-pdf-error-fallback";
import { MeasuredPdfProvider } from "@/components/inspector/measured-pdf-provider";
import { PeekPdfViewer } from "@/components/pdf/peek/peek-pdf-viewer";
import { RecoverableErrorStatus } from "@/components/recoverable-error-status";
import { DefaultPendingComponent } from "@/components/route-components";
import { UnlocatedClaims } from "@/features/avt/original-claims";
import type { OriginalClaimMark } from "@/features/avt/original-claims";
import { PDF_CLAIM_BOX_ATTRIBUTE } from "@/features/avt/original-pdf-claim-box";
import {
  claimPageNumbers,
  resolvePdfClaimLocations,
  selectionVisitKey,
  visitSelection,
} from "@/features/avt/original-pdf.logic";
import type {
  LocatedPdfClaim,
  PdfClaimLocations,
  SelectionVisit,
} from "@/features/avt/original-pdf.logic";
import { originalPdfPagesOptions } from "@/features/avt/queries";
import { STATE_COLOR } from "@/features/avt/state-chip";
import type { VerificationClaim, VerificationRun } from "@/features/avt/types";
import { detached } from "@/lib/detached";
import { fileOptions } from "@/lib/files/queries";
import { usePDFStore } from "@/lib/pdf/pdf-context";
import { toPDFSearchViewportBox } from "@/lib/pdf/pdf-search";
import { useWorkspaceViewParams } from "@/lib/workspaces/use-workspace-view-params";

const ROOT_ATTRIBUTE = "data-avt-original-pdf";
/** The selection visit last brought into view, kept on the pane's element. */
const SHOWN_ATTRIBUTE = "data-avt-shown-visit";

/**
 * Bring the selected claim's box into view once per selection visit, when it
 * is drawn: a page scrolled away and back within the same visit does not
 * pull the reader to it again, and selecting the claim anew does.
 */
const showSelectedOnce = (visitKey: string, element: HTMLElement | null) => {
  const root = element?.closest(`[${ROOT_ATTRIBUTE}]`);
  if (
    element === null ||
    root === null ||
    root === undefined ||
    root.getAttribute(SHOWN_ATTRIBUTE) === visitKey
  ) {
    return;
  }
  root.setAttribute(SHOWN_ATTRIBUTE, visitKey);
  element.scrollIntoView({ block: "nearest", inline: "nearest" });
};

type ClaimId = VerificationClaim["id"];

/** While the page text is still being read, no claim has a place yet. */
const NOT_YET_LOCATED: PdfClaimLocations = { located: [], unlocated: [] };

type OriginalPdfViewProps = {
  workspaceId: string;
  run: VerificationRun;
  claims: readonly VerificationClaim[];
  selected: ClaimId | null;
  markOf: (claim: VerificationClaim) => OriginalClaimMark;
  onSelect: (id: ClaimId) => void;
};

export const OriginalPdfView = ({
  workspaceId,
  run,
  claims,
  selected,
  markOf,
  onSelect,
}: OriginalPdfViewProps) => {
  // The PDF the server read: the upload itself, or the PDF rendition of a
  // non-DOCX upload. The viewer below loads the same file through the same
  // query.
  const { viewId } = useWorkspaceViewParams(workspaceId);
  const fileQuery = useQuery(
    fileOptions({ workspaceId, fieldId: run.fileFieldId, purpose: "display" }),
  );
  const pagesQuery = useQuery(
    originalPdfPagesOptions({
      workspaceId,
      file: fileQuery.data,
      pageNumbers: claimPageNumbers(run.claims),
    }),
  );

  // Page texts that cannot be read (the file, the worker, or the PDF itself)
  // say so and offer a retry, rather than reporting every claim absent.
  const placement = resolvePdfClaimLocations({
    pages: pagesQuery.data,
    failed: fileQuery.isError || pagesQuery.isError,
    blocks: run.blocks,
    claims: run.claims,
  });
  const locations =
    placement.status === "placed" ? placement.locations : NOT_YET_LOCATED;

  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const locatedByPage = new Map<number, LocatedPdfClaim[]>();
  for (const location of locations.located) {
    const onPage = locatedByPage.get(location.pageNumber);
    if (onPage === undefined) {
      locatedByPage.set(location.pageNumber, [location]);
    } else {
      onPage.push(location);
    }
  }
  const unlocated = locations.unlocated.flatMap((id) => {
    const claim = claimById.get(id);
    return claim === undefined ? [] : [claim];
  });

  // Each change of selection is a new visit, adjusted during render.
  const [visit, setVisit] = React.useState<SelectionVisit>({
    id: selected,
    serial: 0,
  });
  const nextVisit = visitSelection(visit, selected);
  if (nextVisit !== visit) {
    setVisit(nextVisit);
  }
  const visitKey = selectionVisitKey(nextVisit);

  const renderClaimMarks = (pageId: string) => (
    <ClaimPageMarks
      claimById={claimById}
      locatedByPage={locatedByPage}
      markOf={markOf}
      pageId={pageId}
      selected={selected}
      visitKey={visitKey}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The boxes are drawn over the page, not focusable: every claim is
          also reachable by keyboard through the stepper and the reading
          view. */}
      <div
        className="min-h-0 flex-1"
        onClickCapture={(event) => {
          if (!(event.target instanceof Element)) {
            return;
          }
          const id = event.target
            .closest(`[${PDF_CLAIM_BOX_ATTRIBUTE}]`)
            ?.getAttribute(PDF_CLAIM_BOX_ATTRIBUTE);
          const claim = claims.find((candidate) => candidate.id === id);
          if (claim !== undefined) {
            // A claim picked by its box is already in view.
            event.currentTarget.setAttribute(
              SHOWN_ATTRIBUTE,
              selectionVisitKey(visitSelection(nextVisit, claim.id)),
            );
            onSelect(claim.id);
          }
        }}
        {...{ [ROOT_ATTRIBUTE]: true }}
      >
        {/* The viewer and the claim boxes read the pages from this store. */}
        <MeasuredPdfProvider
          active
          fallback={{
            suspense: <DefaultPendingComponent />,
            error: <InspectorPdfErrorFallback />,
          }}
          fieldId={run.fileFieldId}
          initialScaleOffset={0}
          surface="avt-original-pdf"
        >
          <PeekPdfViewer
            activePropertyId=""
            entityId={run.entityId}
            fieldId={run.fileFieldId}
            interactionMode="preview-only"
            pdfPageOverlay={renderClaimMarks}
            pdfPageSource="document"
            scaleOffset={0}
            viewId={viewId}
            workspaceId={workspaceId}
          />
        </MeasuredPdfProvider>
      </div>
      {placement.status === "failed" ? (
        <PageTextFailed
          onRetry={() => {
            // A file that did not load is fetched again; its page texts
            // follow. Otherwise only the page texts are read again.
            if (fileQuery.isError) {
              detached(fileQuery.refetch(), "avt.refetch-original-pdf-file");
              return;
            }
            detached(pagesQuery.refetch(), "avt.refetch-original-pdf-pages");
          }}
          retrying={fileQuery.isFetching || pagesQuery.isFetching}
        />
      ) : (
        <UnlocatedClaims
          claims={unlocated}
          markOf={markOf}
          onSelect={onSelect}
          selected={selected}
        />
      )}
    </div>
  );
};

/** The page texts could not be read: no claim is marked, and none is
 *  reported absent. */
const PageTextFailed = ({
  onRetry,
  retrying,
}: {
  onRetry: () => void;
  retrying: boolean;
}) => {
  const t = useTranslations();
  return (
    <RecoverableErrorStatus
      className="text-muted-foreground flex shrink-0 flex-wrap items-center gap-2 border-t px-4 py-2 text-xs"
      message={t("avt.verification.pdfTextFailed")}
      messageClassName="min-w-0 flex-1"
      actions={
        <Button
          loading={retrying}
          onClick={onRetry}
          size="sm"
          variant="outline"
        >
          {t("common.retry")}
        </Button>
      }
    />
  );
};

type ClaimPageMarksProps = {
  pageId: string;
  locatedByPage: ReadonlyMap<number, readonly LocatedPdfClaim[]>;
  claimById: ReadonlyMap<ClaimId, VerificationClaim>;
  selected: ClaimId | null;
  /** The current selection visit, which the selected box shows once. */
  visitKey: string;
  markOf: (claim: VerificationClaim) => OriginalClaimMark;
};

const boxArea = (location: LocatedPdfClaim) =>
  location.boxes.reduce((sum, box) => sum + box.width * box.height, 0);

/** One page's claim boxes, over the canvas and its text layer. */
const ClaimPageMarks = ({
  pageId,
  locatedByPage,
  claimById,
  selected,
  visitKey,
  markOf,
}: ClaimPageMarksProps) => {
  const page = usePDFStore((state) => state.pages.get(pageId));
  if (page === undefined) {
    return null;
  }
  // Where claims overlap, the smaller one is drawn last so a click reaches
  // the claim the reader most plausibly meant; the selected one stays on top.
  const located = locatedByPage.get(page.proxy.pageNumber);
  if (located === undefined || located.length === 0) {
    return null;
  }
  const onPage = located.toSorted(
    (a, b) =>
      Number(a.claimId === selected) - Number(b.claimId === selected) ||
      boxArea(b) - boxArea(a),
  );
  return (
    <div
      aria-hidden={true}
      className="pointer-events-none absolute inset-0 z-2"
    >
      {onPage.flatMap((location) => {
        const claim = claimById.get(location.claimId);
        if (claim === undefined) {
          return [];
        }
        const { state, mark } = markOf(claim);
        const active = claim.id === selected;
        return location.boxes.flatMap((box, boxIndex) => {
          const viewportBox = toPDFSearchViewportBox(box, page.viewport);
          if (
            viewportBox === null ||
            viewportBox.width <= 0 ||
            viewportBox.height <= 0
          ) {
            return [];
          }
          return [
            <div
              className={cn(
                "pointer-events-auto absolute cursor-pointer rounded-xs",
                mark !== null &&
                  textMarkBoxClass({
                    variant: STATE_COLOR[state].mark.variant,
                    tone: STATE_COLOR[state].mark.tone,
                    state: mark,
                  }),
              )}
              data-active={active ? "true" : undefined}
              key={`${claim.id}:${String(boxIndex)}`}
              ref={
                active && boxIndex === 0
                  ? (element: HTMLDivElement | null) => {
                      showSelectedOnce(visitKey, element);
                    }
                  : undefined
              }
              style={viewportBox}
              {...{ [PDF_CLAIM_BOX_ATTRIBUTE]: claim.id }}
            />,
          ];
        });
      })}
    </div>
  );
};
