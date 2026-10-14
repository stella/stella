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

import { textMarkBoxClass } from "@stll/ui/text-mark";
import { cn } from "@stll/ui/utils";

import { PeekPdfViewer } from "@/components/pdf/peek/peek-pdf-viewer";
import { UnlocatedClaims } from "@/features/avt/original-claims";
import type { OriginalClaimMark } from "@/features/avt/original-claims";
import {
  claimPageNumbers,
  locateClaimsOnPages,
} from "@/features/avt/original-pdf.logic";
import type {
  LocatedPdfClaim,
  PdfClaimLocations,
} from "@/features/avt/original-pdf.logic";
import { originalPdfPagesOptions } from "@/features/avt/queries";
import { STATE_COLOR } from "@/features/avt/state-chip";
import type { VerificationClaim, VerificationRun } from "@/features/avt/types";
import { fileOptions } from "@/lib/files/queries";
import { usePDFStore } from "@/lib/pdf/pdf-context";
import { toPDFSearchViewportBox } from "@/lib/pdf/pdf-search";

const CLAIM_ATTRIBUTE = "data-avt-claim";
const ROOT_ATTRIBUTE = "data-avt-original-pdf";
/** The claim last brought into view, kept on the pane's own element. */
const SHOWN_ATTRIBUTE = "data-avt-shown-claim";

/**
 * Bring the selected claim's box into view once, when it is drawn: a page
 * scrolled away and back does not pull the reader to it again.
 */
const showSelectedOnce = (id: string, element: HTMLElement | null) => {
  const root = element?.closest(`[${ROOT_ATTRIBUTE}]`);
  if (
    element === null ||
    root === null ||
    root === undefined ||
    root.getAttribute(SHOWN_ATTRIBUTE) === id
  ) {
    return;
  }
  root.setAttribute(SHOWN_ATTRIBUTE, id);
  element.scrollIntoView({ block: "nearest", inline: "nearest" });
};

type ClaimId = VerificationClaim["id"];

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

  const locate = (): PdfClaimLocations | null => {
    if (pagesQuery.data !== undefined) {
      return locateClaimsOnPages({
        pages: pagesQuery.data,
        blocks: run.blocks,
        claims: run.claims,
      });
    }
    // A file that cannot be read for boxes leaves every claim listed; the
    // viewer shows its own error for a file that does not load.
    if (fileQuery.isError || pagesQuery.isError) {
      return { located: [], unlocated: run.claims.map((claim) => claim.id) };
    }
    return null;
  };
  const locations = locate();

  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const locatedByPage = new Map<number, LocatedPdfClaim[]>();
  for (const location of locations?.located ?? []) {
    const onPage = locatedByPage.get(location.pageNumber) ?? [];
    onPage.push(location);
    locatedByPage.set(location.pageNumber, onPage);
  }
  const unlocated = (locations?.unlocated ?? []).flatMap((id) => {
    const claim = claimById.get(id);
    return claim === undefined ? [] : [claim];
  });

  const renderClaimMarks = (pageId: string) => (
    <ClaimPageMarks
      claimById={claimById}
      locatedByPage={locatedByPage}
      markOf={markOf}
      pageId={pageId}
      selected={selected}
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
            .closest(`[${CLAIM_ATTRIBUTE}]`)
            ?.getAttribute(CLAIM_ATTRIBUTE);
          const claim = claims.find((candidate) => candidate.id === id);
          if (claim !== undefined) {
            // A claim picked by its box is already in view.
            event.currentTarget.setAttribute(SHOWN_ATTRIBUTE, claim.id);
            onSelect(claim.id);
          }
        }}
        {...{ [ROOT_ATTRIBUTE]: true }}
      >
        <PeekPdfViewer
          activePropertyId=""
          entityId={run.entityId}
          fieldId={run.fileFieldId}
          interactionMode="preview-only"
          pdfPageOverlay={renderClaimMarks}
          scaleOffset={0}
          viewId="all"
          workspaceId={workspaceId}
        />
      </div>
      <UnlocatedClaims
        claims={unlocated}
        markOf={markOf}
        onSelect={onSelect}
        selected={selected}
      />
    </div>
  );
};

type ClaimPageMarksProps = {
  pageId: string;
  locatedByPage: ReadonlyMap<number, readonly LocatedPdfClaim[]>;
  claimById: ReadonlyMap<ClaimId, VerificationClaim>;
  selected: ClaimId | null;
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
  markOf,
}: ClaimPageMarksProps) => {
  const page = usePDFStore((state) => state.pages.get(pageId));
  if (page === undefined) {
    return null;
  }
  // Where claims overlap, the smaller one is drawn last so a click reaches
  // the claim the reader most plausibly meant; the selected one stays on top.
  const onPage = (locatedByPage.get(page.proxy.pageNumber) ?? []).toSorted(
    (a, b) =>
      Number(a.claimId === selected) - Number(b.claimId === selected) ||
      boxArea(b) - boxArea(a),
  );
  if (onPage.length === 0) {
    return null;
  }
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
                      showSelectedOnce(claim.id, element);
                    }
                  : undefined
              }
              style={viewportBox}
              {...{ [CLAIM_ATTRIBUTE]: claim.id }}
            />,
          ];
        });
      })}
    </div>
  );
};
