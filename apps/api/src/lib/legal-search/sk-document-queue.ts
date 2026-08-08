/**
 * The order the deferred court documents are fetched in.
 *
 * `sk-document-backfill.ts` defines the two tiers — decisions a reader
 * asked for, and the bulk walk behind them — and binds them to a
 * database handle. This module is the ordering between them, as a
 * continuous stream for the worker that walks the queue.
 *
 * The stream buffers a page per tier so a walk costs one query per page
 * rather than one per document, and re-probes the requested tier on its
 * own interval. That interval is what bounds how long a reader's
 * decision waits behind the bulk walk: a request landing mid-page is
 * served as soon as the probe is due, not at the end of the page.
 *
 * Deliberately free of database and environment imports, so the
 * ordering can be exercised on its own and so importing it opens no
 * connection pool.
 */

import type { PendingDocument } from "@/api/lib/legal-search/sk-document-backfill";

export const DOCUMENT_TIER = {
  /** Asked for by a reader the read path could not serve in time. */
  REQUESTED: "requested",
  /** Everything else: the bulk walk. */
  REMAINING: "remaining",
} as const;

export type DocumentTier = (typeof DOCUMENT_TIER)[keyof typeof DOCUMENT_TIER];

/** A decision to fetch, and which tier it came from. */
export type QueuedDocument = {
  tier: DocumentTier;
  decision: PendingDocument;
};

/**
 * The two tier reads, as functions of a page size. Injected rather than
 * called directly so the ordering can be exercised without a database;
 * `scopedPendingDocumentTierLoaders` builds the production pair.
 */
export type PendingDocumentTierLoaders = {
  loadRequested: (limit: number) => Promise<PendingDocument[]>;
  loadRemaining: (limit: number) => Promise<PendingDocument[]>;
};

export type PendingDocumentQueue = {
  /** The next decision to fetch, or nothing while the queue is empty. */
  next: () => Promise<QueuedDocument | undefined>;
};

export type PendingDocumentQueueOptions = {
  loaders: PendingDocumentTierLoaders;
  /** Rows read per tier query. */
  pageSize: number;
  /**
   * Shortest gap between two requested-tier probes. Zero probes before
   * every document; the walk otherwise pays an extra query per document
   * on a tier that is empty almost always.
   */
  requestedPollIntervalMs: number;
  /** Seam for tests; production reads the clock. */
  now?: () => number;
};

/**
 * A continuous stream over the two tiers.
 *
 * The requested tier is consulted before every document, subject to its
 * probe interval, so a decision a reader asked for is served next rather
 * than after the bulk page in hand. Buffered pages are held per tier and
 * never merged: a requested document that arrives while a bulk page is
 * half-consumed still overtakes the remainder of that page.
 *
 * Nothing here remembers which decisions it has served. It does not have
 * to: fetching a decision claims it, and a claimed decision leaves both
 * tiers for the length of its cooldown, so the next page starts past it.
 * A decision whose fetch failed before it could be claimed comes back,
 * which is the retry.
 */
export const createPendingDocumentQueue = ({
  loaders,
  now = Date.now,
  pageSize,
  requestedPollIntervalMs,
}: PendingDocumentQueueOptions): PendingDocumentQueue => {
  let requested: PendingDocument[] = [];
  let remaining: PendingDocument[] = [];
  /** Negative infinity so the first call always probes. */
  let requestedProbedAt = Number.NEGATIVE_INFINITY;

  const takeRequested = async (): Promise<PendingDocument | undefined> => {
    const buffered = requested.shift();
    if (buffered) {
      return buffered;
    }
    if (now() - requestedProbedAt < requestedPollIntervalMs) {
      return undefined;
    }
    requestedProbedAt = now();
    requested = await loaders.loadRequested(pageSize);
    return requested.shift();
  };

  const takeRemaining = async (): Promise<PendingDocument | undefined> => {
    const buffered = remaining.shift();
    if (buffered) {
      return buffered;
    }
    remaining = await loaders.loadRemaining(pageSize);
    return remaining.shift();
  };

  return {
    next: async () => {
      const priority = await takeRequested();
      if (priority) {
        return { tier: DOCUMENT_TIER.REQUESTED, decision: priority };
      }

      const bulk = await takeRemaining();
      return bulk
        ? { tier: DOCUMENT_TIER.REMAINING, decision: bulk }
        : undefined;
    },
  };
};
