/**
 * The queue's tier predicates are SQL and are pinned against Postgres
 * (`handlers/case-law/ingestion/sk-document-backfill.db.test.ts`). What
 * is pinned here is the ordering between the tiers, which is the part a
 * continuous walk can get wrong in a way nothing reports: a decision a
 * reader asked for that ends up behind the bulk page in hand is still
 * fetched, just far too late, and the walk looks healthy throughout.
 */

import { describe, expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import type { PendingDocument } from "@/api/lib/legal-search/sk-document-backfill";
import type { PendingDocumentTierLoaders } from "@/api/lib/legal-search/sk-document-queue";
import {
  DOCUMENT_TIER,
  createPendingDocumentQueue,
} from "@/api/lib/legal-search/sk-document-queue";

const PAGE_SIZE = 5;
const PROBE_INTERVAL_MS = 5000;

const pending = (caseNumber: string): PendingDocument => ({
  id: createSafeId<"caseLawDecision">(),
  caseNumber,
  ecli: null,
  court: "Okresný súd Bratislava I",
  country: "SVK",
  decisionDate: null,
  decisionType: null,
  documentUrl: `https://example.test/${caseNumber}.pdf`,
});

/**
 * The two tiers as rows rather than as queries. Reads are
 * non-destructive, like the database: a decision leaves a tier when it
 * is claimed, which `serve` below stands in for.
 */
const fakeTiers = () => {
  const rows: Record<"requested" | "remaining", PendingDocument[]> = {
    requested: [],
    remaining: [],
  };
  const queries = { requested: 0, remaining: 0 };

  const loaders: PendingDocumentTierLoaders = {
    loadRequested: async (limit) => {
      queries.requested += 1;
      return await Promise.resolve(rows.requested.slice(0, limit));
    },
    loadRemaining: async (limit) => {
      queries.remaining += 1;
      return await Promise.resolve(rows.remaining.slice(0, limit));
    },
  };

  /** What claiming a decision does to the tiers it was visible in. */
  const serve = (decision: PendingDocument): void => {
    rows.requested = rows.requested.filter(({ id }) => id !== decision.id);
    rows.remaining = rows.remaining.filter(({ id }) => id !== decision.id);
  };

  return { loaders, queries, rows, serve };
};

describe("pending document queue", () => {
  test("a request that arrives mid-walk is served before the rest of the bulk page", async () => {
    // The failure this catches: buffering a bulk page and draining it
    // before looking at the priority tier again, which parks a waiting
    // reader behind a whole page of the backlog.
    const tiers = fakeTiers();
    tiers.rows.remaining = ["bulk-1", "bulk-2", "bulk-3"].map(pending);
    const queue = createPendingDocumentQueue({
      loaders: tiers.loaders,
      now: () => 0,
      pageSize: PAGE_SIZE,
      requestedPollIntervalMs: 0,
    });

    const first = await queue.next();
    expect(first?.decision.caseNumber).toBe("bulk-1");
    if (first) {
      tiers.serve(first.decision);
    }

    tiers.rows.requested = [pending("asked-for")];

    const second = await queue.next();

    expect(second?.tier).toBe(DOCUMENT_TIER.REQUESTED);
    expect(second?.decision.caseNumber).toBe("asked-for");
  });

  test("every requested decision is served before any bulk one", async () => {
    const tiers = fakeTiers();
    tiers.rows.requested = ["asked-1", "asked-2"].map(pending);
    tiers.rows.remaining = ["bulk-1", "bulk-2"].map(pending);
    const queue = createPendingDocumentQueue({
      loaders: tiers.loaders,
      now: () => 0,
      pageSize: PAGE_SIZE,
      requestedPollIntervalMs: 0,
    });

    const served: string[] = [];
    const take = async (): Promise<void> => {
      const queued = await queue.next();
      if (!queued) {
        return;
      }
      tiers.serve(queued.decision);
      served.push(queued.decision.caseNumber);
    };

    await take();
    await take();
    await take();
    await take();

    expect(served).toEqual(["asked-1", "asked-2", "bulk-1", "bulk-2"]);
  });

  test("the probe interval bounds how long a request waits, and nothing longer", async () => {
    // The interval is the whole cost control on the priority tier, so it
    // has to hold in both directions: no probe inside it, a probe as
    // soon as it passes.
    const tiers = fakeTiers();
    tiers.rows.remaining = ["bulk-1", "bulk-2", "bulk-3"].map(pending);
    let clock = 0;
    const queue = createPendingDocumentQueue({
      loaders: tiers.loaders,
      now: () => clock,
      pageSize: PAGE_SIZE,
      requestedPollIntervalMs: PROBE_INTERVAL_MS,
    });

    const first = await queue.next();
    expect(tiers.queries.requested).toBe(1);
    if (first) {
      tiers.serve(first.decision);
    }

    tiers.rows.requested = [pending("asked-for")];
    clock = PROBE_INTERVAL_MS - 1;
    const withinInterval = await queue.next();

    expect(tiers.queries.requested).toBe(1);
    expect(withinInterval?.tier).toBe(DOCUMENT_TIER.REMAINING);
    if (withinInterval) {
      tiers.serve(withinInterval.decision);
    }

    clock = PROBE_INTERVAL_MS;
    const afterInterval = await queue.next();

    expect(tiers.queries.requested).toBe(2);
    expect(afterInterval?.decision.caseNumber).toBe("asked-for");
  });

  test("a page is read once per page, not once per document", async () => {
    // A per-document query would put the walk's database cost on the
    // same clock as its fetch rate, so raising the rate would raise
    // both.
    const tiers = fakeTiers();
    tiers.rows.remaining = [
      "bulk-1",
      "bulk-2",
      "bulk-3",
      "bulk-4",
      "bulk-5",
    ].map(pending);
    const queue = createPendingDocumentQueue({
      loaders: tiers.loaders,
      now: () => 0,
      pageSize: PAGE_SIZE,
      requestedPollIntervalMs: PROBE_INTERVAL_MS,
    });

    const take = async (): Promise<void> => {
      const queued = await queue.next();
      if (queued) {
        tiers.serve(queued.decision);
      }
    };

    await take();
    await take();
    await take();
    await take();
    await take();

    expect(tiers.queries.remaining).toBe(1);
    expect(tiers.queries.requested).toBe(1);
  });

  test("an empty queue reports empty rather than an empty-looking document", async () => {
    const tiers = fakeTiers();
    const queue = createPendingDocumentQueue({
      loaders: tiers.loaders,
      now: () => 0,
      pageSize: PAGE_SIZE,
      requestedPollIntervalMs: 0,
    });

    expect(await queue.next()).toBeUndefined();
  });
});
