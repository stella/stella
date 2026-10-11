/**
 * How long a failing document stays out of the deferred document walk.
 *
 * Each attempt lengthens the decision's own cooldown, and past
 * `MAX_DOCUMENT_FETCH_ATTEMPTS` the decision is parked: out of both tiers,
 * counted, and back only through an explicit requeue. The fixture pairs a
 * decision just inside each boundary with one just outside it, so a
 * predicate that loosens or tightens either boundary fails here.
 *
 * Only a failure that belongs to the document may park it: a failure that
 * may affect every document throws instead, and a verdict reached on a
 * source version the decision no longer holds is dropped.
 */

import { Panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import {
  DOCUMENT_FETCH_EVENT,
  type DocumentStageObserver,
  type DocumentStageObservation,
} from "@stll/legal-atlas/document-fetch-diagnostics";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { SafeId } from "@/api/lib/branded-types";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { observePublisherDocumentFetch } from "@/api/lib/legal-search/document-stage-observation";
import { isUnreadablePdfError } from "@/api/lib/legal-search/parsers/sk-courts";
import {
  claimDocumentFetch,
  countParkedDocuments,
  fetchDecisionDocument,
  loadPendingDocuments,
  markDocumentUnavailable,
  MAX_DOCUMENT_FETCH_ATTEMPTS,
  MAX_REQUEUE_PARKED_DOCUMENTS,
  parkDocumentFetch,
  requeueParkedDocuments,
} from "@/api/lib/legal-search/sk-document-backfill";
import { readOfResponse } from "@/api/tests/helpers/publisher-read";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const HOUR_MS = 60 * 60 * 1000;
const hoursAgo = (hours: number): Date =>
  new Date(Date.now() - hours * HOUR_MS);

/** Wide enough to hold every row this file creates. */
const QUEUE_READ_LIMIT = 100;

type Seed = {
  label: string;
  attempts: number;
  attemptedAt: Date | null;
  /** Whether the walk may hand the decision out now. */
  eligible: boolean;
};

/**
 * The cooldown after attempt n is 6h × 2^(n-1), capped at 96h. Each pair
 * straddles one step of that schedule by a margin wide enough for the
 * test's own clock.
 */
const SEEDS: readonly Seed[] = [
  { label: "untried", attempts: 0, attemptedAt: null, eligible: true },
  {
    label: "1-cooling",
    attempts: 1,
    attemptedAt: hoursAgo(5),
    eligible: false,
  },
  { label: "1-cooled", attempts: 1, attemptedAt: hoursAgo(7), eligible: true },
  {
    label: "3-cooling",
    attempts: 3,
    attemptedAt: hoursAgo(23),
    eligible: false,
  },
  { label: "3-cooled", attempts: 3, attemptedAt: hoursAgo(25), eligible: true },
  {
    label: "7-cooling",
    attempts: 7,
    attemptedAt: hoursAgo(95),
    eligible: false,
  },
  { label: "7-cooled", attempts: 7, attemptedAt: hoursAgo(97), eligible: true },
  {
    label: "parked",
    attempts: MAX_DOCUMENT_FETCH_ATTEMPTS,
    attemptedAt: hoursAgo(24 * 365),
    eligible: false,
  },
];

let testDb: TestDatabase;
let scopedDb: ScopedDb;
const claimFor = async (id: SafeId<"caseLawDecision">) => {
  const claim = await claimDocumentFetch(id, scopedDb);
  expect(claim.status).toBe("claimed");
  if (claim.status !== "claimed") {
    throw new Error("expected claimed snapshot");
  }
  return claim.decision;
};

let sourceId: SafeId<"caseLawSource">;
/** Whether this file inserted the source, and so must remove it. */
let sourceOwnership: "created" | "borrowed" = "borrowed";
const seeded = new Map<string, SafeId<"caseLawDecision">>();
const suffix = Bun.randomUUIDv7().slice(0, 8);

const idFor = (label: string): SafeId<"caseLawDecision"> => {
  const id = seeded.get(label);
  if (id === undefined) {
    throw new Error(`fixture did not seed ${label}`);
  }
  return id;
};

type InsertDecisionOptions = Seed & {
  documentUrl?: string;
  sourceHash?: string | undefined;
};

const insertDecision = async (seed: InsertDecisionOptions): Promise<void> => {
  const [row] = await testDb
    .insert(caseLawDecisions)
    .values({
      sourceId,
      caseNumber: `parking-${suffix}-${seed.label}`,
      court: "Okresný súd",
      country: "SVK",
      language: "sk",
      fulltext: null,
      documentUrl: seed.documentUrl ?? `https://example.test/${seed.label}.pdf`,
      decisionDate: "2026-05-01",
      documentFetchAttempts: seed.attempts,
      documentFetchAttemptedAt: seed.attemptedAt,
      sourceHash: seed.sourceHash,
    })
    .returning({ id: caseLawDecisions.id });
  if (!row) {
    throw new Error("expected decision row");
  }
  seeded.set(seed.label, row.id);
};

/** The seeded decisions the walk would hand out now. */
const queued = async (): Promise<Set<SafeId<"caseLawDecision">>> => {
  const ours = new Set(seeded.values());
  const queue = await loadPendingDocuments({
    scopedDb,
    adapterKey: ADAPTER_KEYS.SK_COURTS,
    limit: QUEUE_READ_LIMIT,
  });
  return new Set(queue.map(({ id }) => id).filter((id) => ours.has(id)));
};

beforeAll(async () => {
  testDb = await getTestDb();
  scopedDb = asTestRaw<ScopedDb>(
    async (callback: (tx: TestDatabase) => Promise<unknown>) =>
      await callback(testDb),
  );

  // The queue resolves its source by adapter key, which is unique, so a
  // source another file left behind is reused rather than duplicated.
  const existing = await testDb.query.caseLawSources.findFirst({
    where: { adapterKey: { eq: ADAPTER_KEYS.SK_COURTS } },
    columns: { id: true },
  });
  if (existing) {
    sourceId = existing.id;
  } else {
    const [source] = await testDb
      .insert(caseLawSources)
      .values({
        adapterKey: ADAPTER_KEYS.SK_COURTS,
        name: `SK parking ${suffix}`,
        enabled: false,
      })
      .returning({ id: caseLawSources.id });
    if (!source) {
      throw new Error("expected source row");
    }
    sourceId = source.id;
    sourceOwnership = "created";
  }

  for (const seed of SEEDS) {
    await insertDecision(seed);
  }
}, 120_000);

afterAll(async () => {
  await testDb
    .delete(caseLawDecisions)
    .where(inArray(caseLawDecisions.id, [...seeded.values()]));
  if (sourceOwnership === "created") {
    await testDb.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
  }
  await releaseTestDb();
});

test("each attempt lengthens the decision's own cooldown", async () => {
  const offered = await queued();

  for (const { label, eligible } of SEEDS) {
    expect({ label, offered: offered.has(idFor(label)) }).toEqual({
      label,
      offered: eligible,
    });
  }
});

test("a parked decision is counted and can be requeued", async () => {
  const parkedBefore = await countParkedDocuments(scopedDb, sourceId);
  expect(parkedBefore).toBeGreaterThanOrEqual(1);

  const requeued = await requeueParkedDocuments({
    scopedDb,
    sourceId,
    limit: 10,
  });

  expect(requeued).toBe(parkedBefore);
  expect(await countParkedDocuments(scopedDb, sourceId)).toBe(0);
  // Its last attempt was long ago, so it is due at once.
  expect(await queued()).toContain(idFor("parked"));
});

test("parking takes a decision out of the walk at once and keeps it pending", async () => {
  await insertDecision({
    label: "to-park",
    attempts: 1,
    attemptedAt: hoursAgo(24 * 365),
    eligible: true,
  });
  expect(await queued()).toContain(idFor("to-park"));
  const parkedBefore = await countParkedDocuments(scopedDb, sourceId);

  expect(
    await parkDocumentFetch({
      decision: await claimFor(idFor("to-park")),
      scopedDb,
    }),
  ).toBe("parked");

  expect(await queued()).not.toContain(idFor("to-park"));
  expect(await countParkedDocuments(scopedDb, sourceId)).toBe(parkedBefore + 1);

  const row = await testDb.query.caseLawDecisions.findFirst({
    where: { id: { eq: idFor("to-park") } },
    columns: { fulltext: true, documentFetchAttempts: true },
  });
  expect(row).toEqual({
    fulltext: null,
    documentFetchAttempts: MAX_DOCUMENT_FETCH_ATTEMPTS,
  });
});

const PUBLISHER_URL =
  "https://obcan.justice.sk/content/public/item/3c4f2a8e-5b1d-4e7a-9c62-8f0d1e2b3a45";

/** A PDF libpdf reads far enough to fail with a plain Error of its own. */
const UNATTRIBUTED_PARSE_FAILURE_PDF = new TextEncoder().encode(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
);

/** A PDF libpdf gives up on as unrecoverable. */
const UNREADABLE_PDF = new TextEncoder().encode("%PDF-1.7 not a pdf");

/**
 * What the promise rejected with; a resolution comes back wrapped so it can
 * never pass for the expected error.
 */
const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    (value: unknown) => ({ resolved: value }),
    (error: unknown) => error,
  );

const fetchState = async (label: string) =>
  await testDb.query.caseLawDecisions.findFirst({
    where: { id: { eq: idFor(label) } },
    columns: { fulltext: true, documentFetchAttempts: true },
  });

type FetchSeededOptions = {
  label: string;
  answer: () => Promise<Response>;
  observe?: DocumentStageObserver;
};

/** One pass of the unit the walk runs, over a seeded decision. */
const fetchSeeded = async ({ answer, label, observe }: FetchSeededOptions) =>
  await fetchDecisionDocument({
    onDocumentObservation: observe,
    decisionId: idFor(label),
    fetchDocument: async () =>
      readOfResponse(
        await observePublisherDocumentFetch({
          source: ADAPTER_KEYS.SK_COURTS,
          fetch: answer,
        }),
      ),
    scopedDb,
    signal: new AbortController().signal,
  });

const insertFetchable = async (
  label: string,
  sourceHash?: string,
): Promise<void> => {
  await insertDecision({
    label,
    attempts: 0,
    attemptedAt: null,
    eligible: true,
    documentUrl: PUBLISHER_URL,
    sourceHash,
  });
};

describe("a failure that may affect every document", () => {
  test("post-response body faults retain their typed outcome without an ok event", async () => {
    const failures = [
      {
        error: new DOMException("private", "TimeoutError"),
        outcome: "timeout",
      },
      {
        error: Object.assign(new TypeError("private"), { code: "ECONNRESET" }),
        outcome: "connection",
      },
    ] as const;
    for (const { error, outcome } of failures) {
      const label = `body-${outcome}`;
      await insertFetchable(label);
      const observations: DocumentStageObservation[] = [];
      const result = await fetchSeeded({
        label,
        observe: (event) => {
          observations.push(event);
        },
        answer: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start: (controller) => {
                controller.error(error);
              },
            }),
            { headers: { "content-type": "application/pdf" } },
          ),
      });
      expect(result).toMatchObject({ status: "deferred", failure: "network" });
      expect(await fetchState(label)).toEqual({
        fulltext: null,
        documentFetchAttempts: 1,
      });
      expect(observations).toEqual([
        {
          event: DOCUMENT_FETCH_EVENT.fetchOutcome,
          source: ADAPTER_KEYS.SK_COURTS,
          outcome,
          http_status: 200,
        },
      ]);
    }
  });

  test("a publisher that is down or refusing this client throws and parks nothing", async () => {
    const parkedBefore = await countParkedDocuments(scopedDb, sourceId);

    for (const status of [500, 502, 503, 504, 401, 403, 429]) {
      const label = `outage-${status}`;
      await insertFetchable(label);

      const thrown = await rejectionOf(
        fetchSeeded({
          label,
          answer: async () =>
            await Promise.resolve(new Response(null, { status })),
        }),
      );

      expect({ status, thrown: thrown instanceof AdapterFetchError }).toEqual({
        status,
        thrown: true,
      });
      // The claim counted the attempt before the download, as it does for
      // every attempt; nothing past it moved the decision toward parking.
      expect({ status, state: await fetchState(label) }).toEqual({
        status,
        state: { fulltext: null, documentFetchAttempts: 1 },
      });
    }
    expect(await countParkedDocuments(scopedDb, sourceId)).toBe(parkedBefore);
  });

  test("a parse failure libpdf does not attribute to the bytes propagates and parks nothing", async () => {
    await insertFetchable("unattributed-parse");

    const thrown = await rejectionOf(
      fetchSeeded({
        label: "unattributed-parse",
        answer: async () =>
          await Promise.resolve(new Response(UNATTRIBUTED_PARSE_FAILURE_PDF)),
      }),
    );

    // The fixture must reach the parser and fail there, unrecognised;
    // otherwise this proves nothing about the catch it guards.
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(AdapterFetchError);
    expect(isUnreadablePdfError(thrown)).toBe(false);
    expect(await fetchState("unattributed-parse")).toEqual({
      fulltext: null,
      documentFetchAttempts: 1,
    });
  });

  test("a body that is not a PDF throws and parks nothing", async () => {
    await insertFetchable("not-a-pdf");
    const observations: DocumentStageObservation[] = [];

    const thrown = await rejectionOf(
      fetchSeeded({
        label: "not-a-pdf",
        observe: (event) => {
          observations.push(event);
        },
        answer: async () =>
          new Response("<html><body>Údržba</body></html>", {
            headers: { "content-type": "application/pdf" },
          }),
      }),
    );

    expect(thrown).toBeInstanceOf(AdapterFetchError);
    expect(observations).toEqual([
      {
        event: DOCUMENT_FETCH_EVENT.fetchOutcome,
        source: ADAPTER_KEYS.SK_COURTS,
        outcome: "body_shape",
        http_status: 200,
      },
    ]);
    expect(await fetchState("not-a-pdf")).toEqual({
      fulltext: null,
      documentFetchAttempts: 1,
    });
  });
});

describe("a stale claim", () => {
  test("buffered decisions fetch only the claimed URL", async () => {
    const currentUrl = PUBLISHER_URL.replace("3c4f2a8e", "4c4f2a8e");
    for (const oldStatus of [200, 404]) {
      const label = `buffered-${oldStatus}`;
      await insertFetchable(label, "source-v1");
      const buffered = (
        await loadPendingDocuments({
          scopedDb,
          adapterKey: ADAPTER_KEYS.SK_COURTS,
          limit: QUEUE_READ_LIMIT,
        })
      ).find(({ id }) => id === idFor(label));
      if (buffered === undefined) {
        throw new Error("expected buffered decision");
      }
      const metadata = {
        caseNumber: `current-${suffix}-${oldStatus}`,
        ecli: "ECLI:SK:OSBA1:2026:1234567890.1",
        court: "Current court",
        country: "SVK",
        decisionDate: "2026-06-01",
        decisionType: "ROZSUDOK",
      };
      await testDb
        .update(caseLawDecisions)
        .set({
          ...metadata,
          documentUrl: currentUrl,
          sourceHash: "source-v2",
        })
        .where(eq(caseLawDecisions.id, buffered.id));
      expect(buffered.documentUrl).not.toBe(currentUrl);
      expect(buffered.caseNumber).not.toBe(metadata.caseNumber);
      const urls: string[] = [];
      const outcome = await fetchDecisionDocument({
        decisionId: buffered.id,
        fetchDocument: async (url) => {
          urls.push(url.href);
          return readOfResponse(
            url.href === currentUrl
              ? new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.error(
                        new DOMException("body timeout", "TimeoutError"),
                      );
                    },
                  }),
                )
              : new Response(oldStatus === 200 ? UNREADABLE_PDF : null, {
                  status: oldStatus,
                }),
          );
        },
        scopedDb,
        signal: new AbortController().signal,
      });
      expect(urls).toEqual([currentUrl]);
      expect(outcome).toEqual({
        status: "deferred",
        failure: "network",
        detail: "TimeoutError",
      });
      expect(await fetchState(label)).toEqual({
        fulltext: null,
        documentFetchAttempts: 1,
      });
    }
  });

  test("the atomic claim returns every processing field from the current row", async () => {
    const label = "claim-snapshot";
    await insertFetchable(label, "source-v1");
    const current = {
      caseNumber: `snapshot-${suffix}`,
      ecli: "ECLI:SK:OSBA1:2026:1234567890.2",
      court: "Snapshot court",
      country: "SVK",
      decisionDate: "2026-07-01",
      decisionType: "UZNESENIE",
      documentUrl: PUBLISHER_URL.replace("3c4f2a8e", "5c4f2a8e"),
      sourceHash: "source-v2",
    };
    await testDb
      .update(caseLawDecisions)
      .set(current)
      .where(eq(caseLawDecisions.id, idFor(label)));
    const claim = await claimDocumentFetch(idFor(label), scopedDb);
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") {
      throw new Error("expected claimed snapshot");
    }
    expect(claim.decision).toMatchObject({ id: idFor(label), ...current });
    expect(claim.attempts).toBe(1);
  });

  const VERSIONS = [null, "source-v1", "source-v2"] as const;

  test("a failure write lands only on the source version its fetch claimed", async () => {
    // Every pairing of the version a fetch claimed with the version the row
    // holds when the write arrives: the write applies exactly on the
    // diagonal, for both writes a failed fetch can make.
    for (const claimed of VERSIONS) {
      for (const current of VERSIONS) {
        const label = `stale-${claimed ?? "none"}-${current ?? "none"}`;
        await insertFetchable(`${label}-park`, claimed ?? undefined);
        await insertFetchable(`${label}-mark`, claimed ?? undefined);
        const parkDecision = await claimFor(idFor(`${label}-park`));
        const markDecision = await claimFor(idFor(`${label}-mark`));
        await testDb
          .update(caseLawDecisions)
          .set({ sourceHash: current })
          .where(
            inArray(caseLawDecisions.id, [parkDecision.id, markDecision.id]),
          );
        const applies = claimed === current;

        const parked = await parkDocumentFetch({
          decision: parkDecision,
          scopedDb,
        });
        await markDocumentUnavailable({
          decision: markDecision,
          scopedDb,
        });

        expect({
          label,
          parked,
          park: await fetchState(`${label}-park`),
          mark: await fetchState(`${label}-mark`),
        }).toEqual({
          label,
          parked: applies ? "parked" : "superseded",
          park: {
            fulltext: null,
            documentFetchAttempts: applies ? MAX_DOCUMENT_FETCH_ATTEMPTS : 1,
          },
          mark: { fulltext: applies ? "" : null, documentFetchAttempts: 1 },
        });
      }
    }
  });

  test("a refresh landing mid-fetch leaves the refreshed decision in the walk", async () => {
    await insertFetchable("refreshed-mid-fetch", "source-v1");

    const outcome = await fetchSeeded({
      label: "refreshed-mid-fetch",
      answer: async () => {
        // Ingestion rewrites the decision while its old document downloads.
        await testDb
          .update(caseLawDecisions)
          .set({ sourceHash: "source-v2" })
          .where(eq(caseLawDecisions.id, idFor("refreshed-mid-fetch")));
        return new Response(UNREADABLE_PDF);
      },
    });

    expect(outcome).toEqual({ status: "superseded" });
    expect(await fetchState("refreshed-mid-fetch")).toEqual({
      fulltext: null,
      documentFetchAttempts: 1,
    });
  });
});

test("a requeue outside its bound is refused before it touches a row", async () => {
  for (const limit of [
    0,
    -1,
    1.5,
    Number.NaN,
    MAX_REQUEUE_PARKED_DOCUMENTS + 1,
  ]) {
    const thrown = await rejectionOf(
      requeueParkedDocuments({ scopedDb, sourceId, limit }),
    );

    expect({ limit, panicked: Panic.is(thrown) }).toEqual({
      limit,
      panicked: true,
    });
  }
});
