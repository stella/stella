// parser-output-unchanged: queue pagination only; document parsing is unchanged.
import { Temporal } from "@stll/time";

import type {
  PendingDocument,
  RemainingDocumentCursor,
} from "@/api/lib/legal-search/sk-document-backfill";

/** Outstanding rows examined in one drain cycle, including ineligible rows. */
export const DOCUMENT_SCAN_ROW_BUDGET = 1000;
/** Candidate page size, independent of the number of ready rows requested. */
export const DOCUMENT_SCAN_PAGE_LIMIT = Math.floor(
  DOCUMENT_SCAN_ROW_BUDGET / 4,
);
export const DOCUMENT_SCAN_REPROBE_MS = 30_000;

export type RemainingDocumentCandidate = PendingDocument & { ready: boolean };

type RemainingDocumentScanOptions = {
  loadPage: (options: {
    limit: number;
    after?: RemainingDocumentCursor;
  }) => Promise<RemainingDocumentCandidate[]>;
  now?: () => number;
};

export type RemainingDocumentScanResult =
  | { type: "rows"; rows: PendingDocument[] }
  | { type: "budget-spent" }
  | { type: "exhausted" };

/**
 * Read cursors live with the queue buffer, not as durable checkpoints.
 * A restart replays unclaimed rows; durable claims exclude cooling work.
 */
export const createRemainingDocumentScan = ({
  loadPage,
  now = () => Temporal.Now.instant().epochMilliseconds,
}: RemainingDocumentScanOptions) => {
  let savedAfter: RemainingDocumentCursor | undefined;
  let savedReprobeAt = Number.NEGATIVE_INFINITY;
  let savedHeadReprobeAt = Number.NEGATIVE_INFINITY;
  let savedHead: { after?: RemainingDocumentCursor } | undefined;

  return async (limit: number): Promise<RemainingDocumentScanResult> => {
    let after = savedAfter;
    let reprobeAt = savedReprobeAt;
    let headReprobeAt = savedHeadReprobeAt;
    let head = savedHead ? { ...savedHead } : undefined;
    // Publish read progress together with the ready buffer. A failed page
    // read must replay any ready rows collected earlier in this call.
    const finish = (result: RemainingDocumentScanResult) => {
      savedAfter = after;
      savedReprobeAt = reprobeAt;
      savedHeadReprobeAt = headReprobeAt;
      savedHead = head;
      return result;
    };
    if (now() < reprobeAt) {
      return { type: "exhausted" };
    }
    if (limit <= 0) {
      return { type: "budget-spent" };
    }
    if (!head && after && now() >= headReprobeAt) {
      head = {};
    }
    if (!after && !head) {
      headReprobeAt = now() + DOCUMENT_SCAN_REPROBE_MS;
    }
    let examined = 0;
    const rows: PendingDocument[] = [];
    while (examined < DOCUMENT_SCAN_ROW_BUDGET) {
      const cursor = head ? head.after : after;
      const pageLimit = Math.min(
        DOCUMENT_SCAN_PAGE_LIMIT,
        DOCUMENT_SCAN_ROW_BUDGET - examined,
      );
      const page = await loadPage({
        limit: pageLimit,
        ...(cursor ? { after: cursor } : {}),
      });
      examined += page.length;
      let consumed = 0;
      for (const { ready, ...decision } of page) {
        const next = { decisionDate: decision.decisionDate, id: decision.id };
        if (head) {
          head.after = next;
        } else {
          after = next;
        }
        consumed += 1;
        if (ready) {
          rows.push(decision);
        }
        if (rows.length === limit) {
          break;
        }
      }
      const exhausted = consumed === page.length && page.length < pageLimit;
      if (head && rows.length > 0) {
        head = undefined;
        headReprobeAt = now() + DOCUMENT_SCAN_REPROBE_MS;
        return finish({ type: "rows", rows });
      }
      if (head && exhausted) {
        head = undefined;
        headReprobeAt = now() + DOCUMENT_SCAN_REPROBE_MS;
      } else if (!head && exhausted) {
        after = undefined;
        reprobeAt = now() + DOCUMENT_SCAN_REPROBE_MS;
        headReprobeAt = reprobeAt;
        return finish(
          rows.length > 0 ? { type: "rows", rows } : { type: "exhausted" },
        );
      }
      if (rows.length === limit || (rows.length > 0 && exhausted)) {
        return finish({ type: "rows", rows });
      }
    }
    return finish(
      rows.length > 0 ? { type: "rows", rows } : { type: "budget-spent" },
    );
  };
};
