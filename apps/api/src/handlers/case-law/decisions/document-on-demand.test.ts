/**
 * What can go wrong here is not the fetch but the bounds around it: a
 * decision linked from a busy page is opened by many readers at once,
 * and every one of them is a download the court's site did not ask for.
 * The read must also survive a fetch that fails, because a decision
 * that cannot be hydrated is still a decision a reader can see.
 */

import { describe, expect, test } from "bun:test";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import {
  isDeferredDocumentFetchable,
  readThroughDeferredDocument,
} from "@/api/handlers/case-law/decisions/document-on-demand";
import type { OnDemandDocumentDeps } from "@/api/handlers/case-law/decisions/document-on-demand";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  BackfilledDocument,
  PendingDocument,
} from "@/api/lib/legal-search/sk-document-backfill";

const TEXT_ELIGIBILITY_FINGERPRINT = "synthetic-text-eligibility";

const availableBudget: OnDemandDocumentDeps["withFetchBudget"] = async (
  _adapterKey,
  operation,
) => ({ status: "completed", value: await operation() });

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
      recordPacingOutcome: () => {},
      withFetchBudget: availableBudget,
      recordRequest: async ({ decisionId }) => {
        requested.push(decisionId);
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
        textEligibilityFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
        textRevisionFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
        adapterKey: "sk-courts",
        decision,
        deps,
        recordDemand: true,
      }),
      readThroughDeferredDocument({
        textEligibilityFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
        textRevisionFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
        adapterKey: "sk-courts",
        decision,
        deps,
        recordDemand: true,
      }),
      readThroughDeferredDocument({
        textEligibilityFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
        textRevisionFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
        adapterKey: "sk-courts",
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

  test("readers with a different text revision do not share the transient document", async () => {
    const { deps, fetched, release } = recorder();
    const decision = pending();
    const first = readThroughDeferredDocument({
      textEligibilityFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
      textRevisionFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
      adapterKey: "sk-courts",
      decision,
      deps,
      recordDemand: false,
    });
    const second = readThroughDeferredDocument({
      textEligibilityFingerprint: "another-text-eligibility",
      textRevisionFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
      adapterKey: "sk-courts",
      decision,
      deps,
      recordDemand: false,
    });

    release();

    expect(await first).toEqual(parsed);
    expect(await second).toBeNull();
    expect(fetched).toEqual([decision.id]);
  });

  test("a failed fetch reads as metadata-only and leaves the request recorded", async () => {
    const { deps, requested, release } = recorder("throws");
    const decision = pending();

    const reader = readThroughDeferredDocument({
      textEligibilityFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
      textRevisionFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
      adapterKey: "sk-courts",
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
      textEligibilityFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
      textRevisionFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
      adapterKey: "sk-courts",
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
      textEligibilityFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
      textRevisionFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
      adapterKey: "sk-courts",
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
      textEligibilityFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
      textRevisionFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
      adapterKey: "sk-courts",
      decision,
      deps,
      recordDemand: true,
    });
    release();

    // The other worker owns its fetch. This reader returns metadata-only
    // instead of sharing a transient AST from a different execution.
    expect(await reader).toBeNull();
  });

  test("a re-read after the fetch finished fetches again and converges", async () => {
    const { deps, fetched, release } = recorder();
    const decision = pending();

    release();
    const first = await readThroughDeferredDocument({
      textEligibilityFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
      textRevisionFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
      adapterKey: "sk-courts",
      decision,
      deps,
      recordDemand: true,
    });
    const second = await readThroughDeferredDocument({
      textEligibilityFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
      textRevisionFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
      adapterKey: "sk-courts",
      decision,
      deps,
      recordDemand: true,
    });

    // Transient results are not cached: a later read performs its own
    // fetch. Durable ingestion is queued independently of this read.
    expect(fetched).toEqual([decision.id, decision.id]);
    expect(second).toEqual(first);
  });

  test("readers past the concurrency cap fall back to the queue", async () => {
    const { deps, fetched, release } = recorder();

    const first = readThroughDeferredDocument({
      textEligibilityFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
      textRevisionFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
      adapterKey: "sk-courts",
      decision: pending(),
      deps,
      recordDemand: true,
    });
    const second = readThroughDeferredDocument({
      textEligibilityFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
      textRevisionFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
      adapterKey: "sk-courts",
      decision: pending(),
      deps,
      recordDemand: true,
    });
    const third = readThroughDeferredDocument({
      textEligibilityFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
      textRevisionFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
      adapterKey: "sk-courts",
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

  /**
   * The module's whole contract in one property: whatever the durable
   * side does, the reader gets an answer. The read that calls this has
   * no error boundary of its own, so a rejection escaping here is a 500
   * on a decision that is merely waiting for its document — the failure
   * mode the metadata-only response exists to prevent.
   *
   * The cases are the ways the fetch unit can actually end: a rejection
   * from the court or the pool, a rejecting demand recording, a claim
   * another worker holds, a unit that never settles, and a resolved
   * outcome whose shape the caller did not expect — which is a
   * rejection raised past the fetch's own guard, on the promise the
   * budget abandons.
   */
  const badShape = {
    recordPacingOutcome: () => {},
    withFetchBudget: availableBudget,
    recordRequest: async () => {
      await Promise.resolve();
    },
    fetchDocument: async () => {
      await Promise.resolve();
      return undefined;
    },
  };
  // SAFETY: deliberately outside the outcome union. The fetch unit is
  // typed, but the read must survive a shape it did not expect all the
  // same: reading `.status` off it throws past the fetch's own guard, on
  // the one promise the read budget abandons.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the point of the case is a value the union forbids
  const badShapeDeps = badShape as unknown as OnDemandDocumentDeps;

  const hostile: Record<string, () => OnDemandDocumentDeps> = {
    "a rejecting fetch": () => ({
      recordPacingOutcome: () => {},
      withFetchBudget: availableBudget,
      recordRequest: async () => {
        await Promise.resolve();
      },
      fetchDocument: async () => {
        await Promise.resolve();
        throw new Error("court site unreachable");
      },
    }),
    "a rejecting demand recording": () => ({
      recordPacingOutcome: () => {},
      withFetchBudget: availableBudget,
      recordRequest: async () => {
        await Promise.resolve();
        throw new Error("row locked");
      },
      fetchDocument: async () => {
        await Promise.resolve();
        return { status: "claimed" };
      },
    }),
    "a fetch that never settles": () => ({
      recordPacingOutcome: () => {},
      withFetchBudget: availableBudget,
      recordRequest: async () => {
        await Promise.resolve();
      },
      fetchDocument: async () =>
        await new Promise<never>(() => {
          // The court never answers, and never says so.
        }),
    }),
    "an unexpected outcome shape": () => badShapeDeps,
  };

  for (const [name, build] of Object.entries(hostile)) {
    test(`${name} reads as metadata-only rather than failing the read`, async () => {
      expect(
        await readThroughDeferredDocument({
          textEligibilityFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
          textRevisionFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
          adapterKey: "sk-courts",
          decision: pending(),
          deps: build(),
          recordDemand: true,
        }),
      ).toBeNull();
    }, 20_000);
  }

  test("only an un-fetched document from a deferred source is fetchable", () => {
    const state = {
      adapterKey: "sk-courts",
      documentUrl: "https://example.test/decision.pdf",
      documentPending: true,
      documentReadFailed: false,
    };

    expect(isDeferredDocumentFetchable(state)).toBe(true);
    // Pending because object storage refused a payload the row does
    // hold. A fetch cannot repair that — the store refuses a row already
    // carrying a corpus document — so every reader during an outage
    // would pay for a download that can never land, and wait out the
    // read budget behind it.
    expect(
      isDeferredDocumentFetchable({ ...state, documentReadFailed: true }),
    ).toBe(false);
    // The read already found something readable stored.
    expect(
      isDeferredDocumentFetchable({ ...state, documentPending: false }),
    ).toBe(false);
    // Nothing to fetch.
    expect(isDeferredDocumentFetchable({ ...state, documentUrl: null })).toBe(
      false,
    );
    // Other sources have no transient reader, so this path cannot fill
    // an empty document for them.
    expect(isDeferredDocumentFetchable({ ...state, adapterKey: "cz-ns" })).toBe(
      false,
    );
  });
});

for (const status of ["busy", "lost"] as const) {
  test(`source ownership ${status} reads as metadata-only with a typed reason`, async () => {
    const decision = pending();
    const reasons: string[] = [];
    const requested: string[] = [];
    const deps: OnDemandDocumentDeps = {
      withFetchBudget: availableBudget,
      recordRequest: async ({ decisionId }) => {
        requested.push(decisionId);
      },
      recordPacingOutcome: (id, reason) => {
        expect(id).toBe(decision.id);
        reasons.push(reason);
      },
      fetchDocument: async () => ({ status }),
    };
    expect(
      await readThroughDeferredDocument({
        textEligibilityFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
        textRevisionFingerprint: TEXT_ELIGIBILITY_FINGERPRINT,
        decision,
        adapterKey: "sk-courts",
        deps,
        recordDemand: true,
      }),
    ).toBeNull();
    expect(reasons).toEqual([`ownership-${status}`]);
    expect(requested).toEqual([decision.id]);
  });
}
