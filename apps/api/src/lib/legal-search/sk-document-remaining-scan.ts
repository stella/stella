// parser-output-unchanged: queue pagination only; document parsing is unchanged.
import { Temporal } from "@stll/time";

import type {
  PendingDocument,
  RemainingDocumentCursor,
} from "@/api/lib/legal-search/sk-document-backfill";

/** Outstanding rows examined in one drain cycle, including ineligible rows. */
export const DOCUMENT_SCAN_ROW_BUDGET = 1000;
/** Three cursor ranges plus one periodic head probe share the cycle budget. */
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

/**
 * The cursor is a read position, not a processing checkpoint. It lives with
 * the queue's buffer; a crash discards both and replays from the newest row.
 * Durable per-document claims exclude completed or cooling work on replay.
 */
export const createRemainingDocumentScan = ({
  loadPage,
  now = () => Temporal.Now.instant().epochMilliseconds,
}: RemainingDocumentScanOptions) => {
  let after: RemainingDocumentCursor | undefined;
  let reprobeAt = Number.NEGATIVE_INFINITY;
  let headReprobeAt = Number.NEGATIVE_INFINITY;

  const readyDocuments = (page: RemainingDocumentCandidate[]) =>
    page
      .filter(({ ready }) => ready)
      .map(({ ready: _ready, ...decision }) => decision);

  return async (limit: number): Promise<PendingDocument[]> => {
    if (now() < reprobeAt || limit <= 0) {
      return [];
    }
    const pageLimit = Math.min(limit, DOCUMENT_SCAN_PAGE_LIMIT);
    // New decisions and newly due retries must not wait behind an active
    // archive sweep. Probe the newest bounded window on its own cadence.
    if (now() >= headReprobeAt) {
      if (after) {
        const head = readyDocuments(await loadPage({ limit: pageLimit }));
        headReprobeAt = now() + DOCUMENT_SCAN_REPROBE_MS;
        if (head.length > 0) {
          return head;
        }
      } else {
        headReprobeAt = now() + DOCUMENT_SCAN_REPROBE_MS;
      }
    }
    const page = await loadPage({
      limit: pageLimit,
      ...(after ? { after } : {}),
    });
    const last = page.at(-1);
    after = last ? { decisionDate: last.decisionDate, id: last.id } : undefined;
    if (page.length < pageLimit) {
      after = undefined;
      reprobeAt = now() + DOCUMENT_SCAN_REPROBE_MS;
    }
    return readyDocuments(page);
  };
};
