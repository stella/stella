/**
 * What can go wrong here is not the fetch but the bounds around it: a
 * decision linked from a busy page is opened by many readers at once,
 * and every one of them is a download the court's site did not ask for.
 * The read must also survive a fetch that fails, because a decision
 * that cannot be hydrated is still a decision a reader can see.
 */

import { describe, expect, test } from "bun:test";

import {
  isDeferredDocumentFetchable,
  readThroughDeferredDocument,
} from "@/api/handlers/case-law/decisions/document-on-demand";
import type { OnDemandDocumentDeps } from "@/api/handlers/case-law/decisions/document-on-demand";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import type {
  BackfilledDocument,
  PendingDocument,
} from "@/api/handlers/case-law/ingestion/sk-document-backfill";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";

const pending = (): PendingDocument => ({
  id: createSafeId<"caseLawDecision">(),
  caseNumber: "1T/1/2026",
  ecli: null,
  court: "Okresný súd",
  country: "SVK",
  decisionDate: "2026-07-01",
  decisionType: "rozsudok",
  documentUrl: "https://example.test/decision.pdf",
});

const documentAst: DocumentAst = {
  version: 1,
  source: {
    system: "example",
    documentId: "on-demand",
    webUrl: "https://example.test/web",
    printUrl: "",
  },
  metadata: {
    caseNumber: "1T/1/2026",
    ecli: null,
    court: "Okresný súd",
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      id: "b1",
      anchorId: "h-1",
      type: "heading",
      level: 1,
      plainText: "Rozsudok",
      inlines: [{ type: "text", text: "Rozsudok" }],
    },
  ],
};

const parsed: BackfilledDocument = {
  fulltext: "Rozsudok\n\nOdôvodnenie:\n\nText.",
  documentAst,
  sections: [],
};

type Recorder = {
  deps: OnDemandDocumentDeps;
  requested: SafeId<"caseLawDecision">[];
  fetched: SafeId<"caseLawDecision">[];
  release: () => void;
};

/**
 * Deps whose fetch blocks until released, so two readers can be in the
 * handler at the same time the way they are in production.
 */
const recorder = (
  outcome: "claimed" | "filled" | "throws" | "unavailable" = "filled",
): Recorder => {
  const requested: SafeId<"caseLawDecision">[] = [];
  const fetched: SafeId<"caseLawDecision">[] = [];
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    requested,
    fetched,
    release: () => {
      release();
    },
    deps: {
      recordRequest: async (id) => {
        requested.push(id);
        await Promise.resolve();
      },
      fetchDocument: async (decision) => {
        fetched.push(decision.id);
        await gate;
        if (outcome === "throws") {
          throw new Error("court site unreachable");
        }
        if (outcome === "filled") {
          return { status: "filled", document: parsed };
        }

        return outcome === "claimed"
          ? { status: "claimed" }
          : { status: "unavailable" };
      },
    },
  };
};

describe("deferred document read-through", () => {
  test("many readers of one decision cause one fetch", async () => {
    const { deps, fetched, release } = recorder();
    const decision = pending();

    const readers = [
      readThroughDeferredDocument({
        decision,
        deps,
        recordDemand: true,
      }),
      readThroughDeferredDocument({
        decision,
        deps,
        recordDemand: true,
      }),
      readThroughDeferredDocument({
        decision,
        deps,
        recordDemand: true,
      }),
    ];
    release();
    const documents = await Promise.all(readers);

    expect(fetched).toEqual([decision.id]);
    // Every reader gets the document, not just the one that fetched it.
    expect(documents).toEqual([parsed, parsed, parsed]);
  });

  test("a failed fetch reads as metadata-only and leaves the request recorded", async () => {
    const { deps, requested, release } = recorder("throws");
    const decision = pending();

    const reader = readThroughDeferredDocument({
      decision,
      deps,
      recordDemand: true,
    });
    release();

    expect(await reader).toBeNull();
    expect(requested).toEqual([decision.id]);
  });

  test("a reader we cannot attribute hydrates without queueing demand", async () => {
    const { deps, requested, fetched, release } = recorder();
    const decision = pending();

    const reader = readThroughDeferredDocument({
      decision,
      deps,
      recordDemand: false,
    });
    release();

    // The document is still fetched with a free slot — what it must not
    // do is mint a priority row that steers the crawler.
    expect(await reader).toEqual(parsed);
    expect(fetched).toEqual([decision.id]);
    expect(requested).toEqual([]);
  });

  test("a document the source cannot serve reads as metadata-only", async () => {
    const { deps, release } = recorder("unavailable");
    const decision = pending();

    const reader = readThroughDeferredDocument({
      decision,
      deps,
      recordDemand: true,
    });
    release();

    expect(await reader).toBeNull();
  });

  test("a decision another worker is fetching reads as metadata-only", async () => {
    const { deps, release } = recorder("claimed");
    const decision = pending();

    const reader = readThroughDeferredDocument({
      decision,
      deps,
      recordDemand: true,
    });
    release();

    // The other worker's fetch will store the document; this reader
    // does not wait for it and does not fetch it again.
    expect(await reader).toBeNull();
  });

  test("a re-read after the fetch finished fetches again and converges", async () => {
    const { deps, fetched, release } = recorder();
    const decision = pending();

    release();
    const first = await readThroughDeferredDocument({
      decision,
      deps,
      recordDemand: true,
    });
    const second = await readThroughDeferredDocument({
      decision,
      deps,
      recordDemand: true,
    });

    // Nothing caches the outcome in memory: the second read runs the
    // same idempotent unit again and reaches the same document. In
    // production the first fetch has already filled the row, so the
    // second read never gets this far.
    expect(fetched).toEqual([decision.id, decision.id]);
    expect(second).toEqual(first);
  });

  test("readers past the concurrency cap fall back to the queue", async () => {
    const { deps, fetched, release } = recorder();

    const first = readThroughDeferredDocument({
      decision: pending(),
      deps,
      recordDemand: true,
    });
    const second = readThroughDeferredDocument({
      decision: pending(),
      deps,
      recordDemand: true,
    });
    const third = readThroughDeferredDocument({
      decision: pending(),
      deps,
      recordDemand: true,
    });

    // The third reader is turned away without waiting for the release.
    expect(await third).toBeNull();

    release();
    await Promise.all([first, second]);

    expect(fetched).toHaveLength(2);
  });

  test("only an un-fetched document from a deferred source is fetchable", () => {
    const state = {
      adapterKey: "sk-courts",
      documentUrl: "https://example.test/decision.pdf",
      documentPending: true,
    };

    expect(isDeferredDocumentFetchable(state)).toBe(true);
    // The read already found something readable stored.
    expect(
      isDeferredDocumentFetchable({ ...state, documentPending: false }),
    ).toBe(false);
    // Nothing to fetch.
    expect(isDeferredDocumentFetchable({ ...state, documentUrl: null })).toBe(
      false,
    );
    // Other sources store the document during the crawl, so an empty
    // one of theirs is a gap this path cannot fill.
    expect(isDeferredDocumentFetchable({ ...state, adapterKey: "cz-ns" })).toBe(
      false,
    );
  });
});
