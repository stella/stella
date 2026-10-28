import { panic, Result } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources, relations } from "@/api/db/schema";
import type { SourceRegistration } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { czNsAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import { sourceFingerprint } from "@/api/handlers/case-law/ingestion/source-fingerprint";
import { createSafeId } from "@/api/lib/branded-types";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import {
  FULLTEXT_RECOVERY_LIMITS,
  pendingDecisionText,
  verifiedDecisionText,
} from "@/api/lib/case-law/fulltext-state";
import { planCorpusDocumentWrite } from "@/api/lib/legal-search/corpus-storage";
import { EMPTY_AST } from "@/api/lib/legal-search/document-types";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { StoredRawReadError } from "@/api/lib/legal-search/ingestion-types";
import type {
  DecisionSupplement,
  IngestionResult,
  SourceAdapter,
  SourceReconciliation,
} from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import {
  RAW_SOURCE_FAMILY,
  rawSourcePayloadKey,
} from "@/api/lib/legal-search/raw-source-storage";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { runDecisionFulltextRecoveryUnit } from "./fulltext-reconciler";

const sourceId = createSafeId<"caseLawSource">();
let client: Awaited<ReturnType<typeof createTestPglite>>;
const connect = (connection: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({
    client: connection,
    relations: { ...relations, ...authRelationsPart },
  });
let db: ReturnType<typeof connect>;
const scopedDb: ScopedDb = async (work) =>
  await db.transaction(async (tx) => await work(asTestRaw(tx)));
let clock = new Date("2026-10-28T12:00:00.000Z");
let publisherCalls = 0;
let builds = 0;
const postgresOnly = {
  mode: "off",
  transfer: {
    layout: "packs",
    putPacks: () =>
      panic("Postgres-only fixture must never transfer corpus bytes"),
  },
} satisfies CaseLawCorpusDependencies;
const advance = (milliseconds = 31_000) => {
  clock = new Date(clock.getTime() + milliseconds);
};
const documentId = "held-document";
const caseNumber = "30 Cdo 4444/2026";
const body = "Nejvyšší soud rozhodl o dovolání a dovolání zamítl.";
const candidate = (decisionType = "rozsudek"): IngestionResult =>
  plainTextIngestionResult({
    caseNumber,
    sourceDocumentId: documentId,
    country: "CZE",
    language: "cs",
    court: "Nejvyšší soud",
    decisionDate: "2026-01-15",
    decisionType,
    sourceUrl: "https://www.nsoud.cz/fixture",
    documentUrl: "https://www.nsoud.cz/fixture.pdf",
    fulltext: body,
    metadata: {},
    documentAst: EMPTY_AST,
    rawHash: "b".repeat(64),
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  });
type AdapterCallbacks = {
  list?: SourceReconciliation["listSlicePage"];
  build?: SourceReconciliation["buildDecision"];
  reparse?: SourceAdapter["reparseStoredRaw"];
};
const registration = ({ list, build, reparse }: AdapterCallbacks = {}) => {
  const listSlicePage = (async (options) => {
    publisherCalls++;
    return list === undefined
      ? {
          totalPages: 1,
          items: [
            {
              identity: { type: "document", sourceDocumentId: documentId },
              payload: {},
            },
          ],
        }
      : await list(options);
  }) satisfies SourceReconciliation["listSlicePage"];
  const buildDecision = (async (payload, signal) => {
    builds++;
    return build === undefined
      ? { type: "detail-unavailable" }
      : await build(payload, signal);
  }) satisfies SourceReconciliation["buildDecision"];
  const reparseStoredRaw = (async (stored) => {
    const reader = reparse ?? czNsAdapter.reparseStoredRaw;
    if (reader === undefined) {
      return panic("Fixture source has no stored raw parser");
    }
    return await reader(stored);
  }) satisfies NonNullable<SourceAdapter["reparseStoredRaw"]>;
  return {
    key: ADAPTER_KEYS.CZ_NS,
    capability: "crawl",
    source: {
      ...czNsAdapter,
      reparseStoredRaw,
      reconciliation: {
        ...czNsAdapter.reconciliation,
        createSliceBuildDecision: undefined,
        listSlicePage,
        buildDecision,
      },
    },
  } satisfies SourceRegistration;
};
const seed = async (
  overrides: Partial<typeof caseLawDecisions.$inferInsert> = {},
) => {
  const id = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values({
    id,
    sourceId,
    caseNumber,
    sourceDocumentId: documentId,
    country: "CZE",
    language: "cs",
    court: "Nejvyšší soud",
    decisionDate: "2026-01-15",
    sourceHash: "a".repeat(64),
    sourceObservationOrder: 1n,
    documentAst: EMPTY_AST,
    metadata: {},
    textState: pendingDecisionText({
      now: clock,
      attemptCount: 0,
      lastAttemptAt: null,
      delayMs: 0,
    }),
    ...overrides,
  });
  return id;
};
const rowOf = async (id: typeof caseLawDecisions.$inferSelect.id) =>
  (
    await db.select().from(caseLawDecisions).where(eq(caseLawDecisions.id, id))
  ).at(0) ?? panic("Missing fixture decision");
const run = async (
  options: Partial<Parameters<typeof runDecisionFulltextRecoveryUnit>[0]> = {},
) =>
  await runDecisionFulltextRecoveryUnit({
    sourceId,
    registration: registration(),
    publisherAccess: "enabled",
    scopedDb,
    now: () => clock,
    signal: AbortSignal.timeout(30_000),
    corpus: postgresOnly,
    ...options,
  });

beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);
  await db
    .insert(caseLawSources)
    .values(caseLawSourceRow({ id: sourceId, adapterKey: ADAPTER_KEYS.CZ_NS }));
});
afterAll(async () => await client.close());
beforeEach(async () => {
  await db
    .delete(caseLawDecisions)
    .where(eq(caseLawDecisions.sourceId, sourceId));
  await db
    .update(caseLawSources)
    .set({
      config: {},
      enabled: true,
      observationOrder: 1n,
      ingestionLeaseToken: null,
      ingestionLeaseExpiresAt: null,
    })
    .where(eq(caseLawSources.id, sourceId));
  clock = new Date("2026-10-28T12:00:00.000Z");
  publisherCalls = 0;
  builds = 0;
});

describe.serial(
  "full-text recovery uses actual durable claims and normal ingestion",
  () => {
    test("readable postgres bytes produce proof once, without publisher I/O", async () => {
      const id = await seed({ fulltext: body });
      expect(await run()).toMatchObject({
        type: "worked",
        summary: { verified: 1 },
      });
      expect((await rowOf(id)).textState).toMatchObject({
        status: "stored",
        storage: "postgres",
      });
      advance();
      expect(await run()).toEqual({ type: "idle" });
      expect(publisherCalls).toBe(0);
    });
    test("pointer-only decoded empty objects never become proof and retain typed publisher failure", async () => {
      const id = await seed({
        contentHash: "a".repeat(64),
        textS3Key: "text",
        normalizedS3Key: "sections",
        astS3Key: "ast",
      });
      expect(
        await run({
          readPayload: async () => ({
            storage: "corpus",
            payload: { text: "", sections: [], ast: EMPTY_AST },
          }),
        }),
      ).toMatchObject({ type: "worked", summary: { failed: 1 } });
      expect((await rowOf(id)).textState).toMatchObject({
        status: "fetch_failed",
        cause: { kind: "parser_refusal", code: "listing_detail_unavailable" },
      });
      expect(publisherCalls).toBe(1);
      expect(builds).toBe(1);
    });
    test("storage read errors become typed backoff when publisher access is disabled", async () => {
      const id = await seed();
      await run({
        publisherAccess: "disabled",
        readPayload: async () => {
          throw new TypeError("fixture object read failed");
        },
      });
      const state = (await rowOf(id)).textState;
      expect(state).toMatchObject({
        status: "fetch_failed",
        cause: { kind: "storage" },
        attemptCount: 1,
      });
      expect(
        state?.status === "fetch_failed" &&
          state.nextAttemptAt > clock.toISOString(),
      ).toBe(true);
      expect(publisherCalls).toBe(0);
    });
    test("unexpired item claims are skipped; expired claims replay to a fixed point", async () => {
      const id = await seed({
        fulltext: body,
        textState: pendingDecisionText({
          now: clock,
          attemptCount: 1,
          lastAttemptAt: clock.toISOString(),
          delayMs: FULLTEXT_RECOVERY_LIMITS.CLAIM_MS,
        }),
      });
      expect(await run()).toEqual({ type: "idle" });
      advance(FULLTEXT_RECOVERY_LIMITS.CLAIM_MS + 1);
      expect(await run()).toMatchObject({
        type: "worked",
        summary: { verified: 1 },
      });
      expect((await rowOf(id)).textState?.status).toBe("stored");
      advance();
      expect(await run()).toEqual({ type: "idle" });
    });
    test("listing recovery checkpoints page four, resumes later and writes the found body through ingestion", async () => {
      const id = await seed();
      const pages: number[] = [];
      const source = registration({
        list: async ({ page }) => {
          pages.push(page);
          return {
            totalPages: 6,
            items:
              page === 5
                ? [
                    {
                      identity: {
                        type: "document",
                        sourceDocumentId: documentId,
                      },
                      payload: {},
                    },
                  ]
                : [],
          };
        },
        build: async () => ({ type: "built", decision: candidate() }),
      });
      expect(await run({ registration: source })).toMatchObject({
        type: "worked",
        summary: { continued: 1 },
      });
      expect(pages).toEqual([0, 1, 2, 3]);
      expect((await rowOf(id)).textState).toMatchObject({
        status: "fetch_pending",
        recovery: { type: "publisher_listing", page: 4 },
      });
      advance();
      expect(await run({ registration: source })).toMatchObject({
        type: "worked",
        summary: { recovered: 1 },
      });
      expect(pages).toEqual([0, 1, 2, 3, 4, 5]);
      expect((await rowOf(id)).fulltext).toBe(body);
      expect((await rowOf(id)).textState?.status).toBe("stored");
    });
    test("an active source ingestion lease prevents every recovery side effect", async () => {
      await seed({ fulltext: body });
      await db
        .update(caseLawSources)
        .set({
          ingestionLeaseToken: createSafeId<"caseLawSourceIngestionLease">(),
          ingestionLeaseExpiresAt: new Date(Date.now() + 60_000),
        })
        .where(eq(caseLawSources.id, sourceId));
      expect(
        await run({
          readPayload: async () => panic("A foreign lease must block reads"),
        }),
      ).toEqual({ type: "leased" });
      expect(publisherCalls).toBe(0);
    });
    test("a new source observation during I/O prevents the old payload proof from settling", async () => {
      const id = await seed();
      await run({
        readPayload: async () => {
          await db
            .update(caseLawDecisions)
            .set({
              fulltext: "Newer source text",
              sourceHash: "b".repeat(64),
              sourceObservationOrder: 2n,
            })
            .where(eq(caseLawDecisions.id, id));
          return {
            storage: "postgres",
            payload: { text: body, sections: null, ast: EMPTY_AST },
          };
        },
      });
      expect((await rowOf(id)).fulltext).toBe("Newer source text");
      expect((await rowOf(id)).textState).toMatchObject({
        status: "fetch_pending",
        attemptCount: 0,
      });
      expect(publisherCalls).toBe(0);
    });
    test("erasure between the storage read and completion cannot resurrect proof", async () => {
      const id = await seed();
      await run({
        readPayload: async () => {
          await db
            .update(caseLawDecisions)
            .set({
              redactedAt: clock,
              fulltext: null,
              sections: null,
              documentAst: null,
              contentHash: null,
            })
            .where(eq(caseLawDecisions.id, id));
          return {
            storage: "postgres",
            payload: { text: body, sections: null, ast: EMPTY_AST },
          };
        },
      });
      const erased = await rowOf(id);
      expect(erased.redactedAt).not.toBeNull();
      expect(erased.textState).toBeNull();
      expect(erased.fulltext).toBeNull();
      expect(publisherCalls).toBe(0);
    });
    test("a disabled source may verify stored postgres bytes, but never follows a listing continuation", async () => {
      await db
        .update(caseLawSources)
        .set({ enabled: false })
        .where(eq(caseLawSources.id, sourceId));
      const readable = await seed({ fulltext: body });
      await run({ publisherAccess: "disabled" });
      expect((await rowOf(readable)).textState?.status).toBe("stored");
      const waiting = await seed({
        sourceDocumentId: "waiting",
        caseNumber: "30 Cdo 4445/2026",
        textState: pendingDecisionText({
          now: clock,
          attemptCount: 0,
          lastAttemptAt: null,
          delayMs: 0,
          recovery: { type: "publisher_listing", slice: "2026", page: 4 },
        }),
      });
      advance();
      await run({ publisherAccess: "enabled" });
      expect(publisherCalls).toBe(0);
      expect((await rowOf(waiting)).textState).toMatchObject({
        status: "fetch_pending",
        recovery: { type: "publisher_listing", page: 4 },
      });
    });
    test("unfinished immutable raw replay bypasses readable postgres text and remains retryable on raw read failure", async () => {
      const id = await seed({
        fulltext: body,
        sourceRawS3Key: "raw/immutable",
        sourceRawContentType: "text/html",
        textState: pendingDecisionText({
          now: clock,
          attemptCount: 0,
          lastAttemptAt: null,
          delayMs: 0,
          recovery: { type: "stored_raw_retry" },
        }),
      });
      let rawReads = 0;
      await run({
        publisherAccess: "disabled",
        registration: registration({
          reparse: async () => ({ type: "parsed", result: candidate() }),
        }),
        readPayload: async () =>
          panic(
            "Unfinished raw replay cannot take the readable postgres shortcut",
          ),
        readRaw: async () => {
          rawReads++;
          throw new TypeError("immutable raw object temporarily unreadable");
        },
      });
      expect(rawReads).toBe(1);
      expect(publisherCalls).toBe(0);
      expect((await rowOf(id)).textState).toMatchObject({
        status: "fetch_failed",
        recovery: { type: "stored_raw_retry" },
      });
    });
    test("stored raw settlement retries normal ingestion after a corpus write failure instead of accepting readable postgres", async () => {
      const raw = "<html><body>immutable publisher document</body></html>";
      const id = await seed({ sourceRawContentType: "text/html" });
      const rawKey = rawSourcePayloadKey({
        owner: { family: RAW_SOURCE_FAMILY.CASE_LAW, sourceId, documentId: id },
        data: raw,
      });
      await db
        .update(caseLawDecisions)
        .set({ sourceRawS3Key: rawKey })
        .where(eq(caseLawDecisions.id, id));
      // The database invalidates raw-pointer changes using its wall clock;
      // make this prepared row due under the scheduler's fixed test clock.
      await db
        .update(caseLawDecisions)
        .set({
          textState: pendingDecisionText({
            now: clock,
            attemptCount: 0,
            lastAttemptAt: null,
            delayMs: 0,
          }),
        })
        .where(eq(caseLawDecisions.id, id));
      let reads = 0;
      let reparses = 0;
      let writes = 0;
      const adapter = registration({
        reparse: async ({ raw: bytes }) => {
          reparses++;
          expect(new TextDecoder().decode(bytes)).toBe(raw);
          return {
            type: "parsed",
            result: {
              ...candidate(),
              sourceRaw: raw,
              sourceRawContentType: "text/html",
              rawHash: sourceFingerprint({ sourceRaw: raw }),
            },
          };
        },
      });
      const corpus = {
        mode: "dual-write",
        transfer: {
          layout: "objects",
          writeObjects: async (input) => {
            writes++;
            if (writes === 1) {
              throw new TypeError("transient corpus transfer failure");
            }
            const plan = planCorpusDocumentWrite(input);
            return plan.type === "put"
              ? { type: "written", written: plan.written }
              : plan;
          },
        },
      } satisfies CaseLawCorpusDependencies;
      const options = {
        registration: adapter,
        corpus,
        readRaw: async () => {
          reads++;
          return Result.ok(new TextEncoder().encode(raw));
        },
        sourceFingerprintFromStoredRaw: async () =>
          sourceFingerprint({ sourceRaw: raw }),
      };
      await db
        .update(caseLawSources)
        .set({ enabled: false })
        .where(eq(caseLawSources.id, sourceId));
      await run({ ...options, publisherAccess: "disabled" });
      const unsettled = await rowOf(id);
      expect({ reads, reparses, state: unsettled.textState }).toMatchObject({
        reads: 1,
        reparses: 1,
        state: {
          status: "fetch_pending",
          recovery: { type: "stored_raw_retry" },
        },
      });
      expect(unsettled.fulltext).toBe(body);
      expect(unsettled.textState).toMatchObject({
        status: "fetch_pending",
        recovery: { type: "stored_raw_retry" },
      });
      expect(writes).toBe(1);
      advance(FULLTEXT_RECOVERY_LIMITS.INITIAL_RETRY_MS + 1);
      await run({
        ...options,
        publisherAccess: "disabled",
        readPayload: async () =>
          panic(
            "Unfinished raw settlement must replay even with readable postgres bytes",
          ),
      });
      expect(writes).toBe(2);
      expect(reads).toBe(2);
      expect(reparses).toBe(2);
      expect((await rowOf(id)).textState).toMatchObject({
        status: "stored",
        storage: "corpus",
      });
      expect(publisherCalls).toBe(0);
    });
    test.each(["publisher_listing", "stored_raw_retry"] as const)(
      "%s: a real supplement judgment read retry stays durable and is never counted recovered",
      async (phase) => {
        const judgmentRawLocator = "raw/judgment";
        const judgmentText =
          "Stored judgment awaiting its separately served reasons.";
        const judgmentProof =
          verifiedDecisionText({
            payload: { text: judgmentText, sections: null, ast: EMPTY_AST },
            caseNumberType: "case-number",
            storage: "postgres",
            now: clock,
          }) ?? panic("Nonempty fixture judgment must have readable proof");
        await seed({
          sourceDocumentId: "judgment",
          decisionType: "rozsudek",
          fulltext: judgmentText,
          sourceRawS3Key: judgmentRawLocator,
          sourceRawContentType: "text/html",
          textState: judgmentProof,
        });
        const recovery =
          phase === "publisher_listing"
            ? { type: phase, slice: "2026", page: 4 }
            : { type: phase };
        const heldRawKey = "raw/held-supplement";
        const id = await seed({
          decisionType: "reasons",
          ...(phase === "stored_raw_retry"
            ? {
                sourceRawS3Key: heldRawKey,
                sourceRawContentType: "text/html",
                fulltext: body,
              }
            : {}),
          textState: pendingDecisionText({
            now: clock,
            attemptCount: 0,
            lastAttemptAt: null,
            delayMs: 0,
            recovery,
          }),
        });
        const supplement = {
          kind: "reasons",
          target: {
            decisionTypes: ["rozsudek"],
            latestDecisionDate: "2026-01-15",
          },
          document: {
            ...candidate("reasons"),
            sourceDocumentId: documentId,
          },
        } satisfies DecisionSupplement;
        let judgmentReads = 0;
        let heldReads = 0;
        const outcome = await run({
          registration: registration({
            list: async () => ({
              totalPages: 5,
              items: [
                {
                  identity: { type: "document", sourceDocumentId: documentId },
                  payload: {},
                },
              ],
            }),
            build: async () => ({ type: "built-supplement", supplement }),
            reparse: async () => ({ type: "supplement", supplement }),
          }),
          readRaw: async (key) => {
            if (key === judgmentRawLocator) {
              judgmentReads++;
              return Result.err(
                new StoredRawReadError({
                  message: "Fixture judgment storage unavailable",
                  key,
                  cause: new TypeError("temporary object read error"),
                  permanent: false,
                }),
              );
            }
            expect(key).toBe(heldRawKey);
            heldReads++;
            return Result.ok(
              new TextEncoder().encode("immutable supplement input"),
            );
          },
        });
        expect(judgmentReads).toBe(1);
        expect(heldReads).toBe(phase === "stored_raw_retry" ? 1 : 0);
        expect(outcome).toMatchObject({
          type: "worked",
          summary: { recovered: 0, continued: 1 },
        });
        const pending = (await rowOf(id)).textState;
        expect(pending).toMatchObject({ status: "fetch_pending", recovery });
        expect(
          pending?.status === "fetch_pending" &&
            pending.nextAttemptAt > clock.toISOString(),
        ).toBe(true);
        expect(publisherCalls).toBe(phase === "publisher_listing" ? 1 : 0);
      },
    );
    test.each([
      ["next-page", "revision"],
      ["next-page", "erasure"],
      ["build", "revision"],
      ["build", "erasure"],
    ] as const)(
      "superseded %s checkpoint after %s prevents all further publisher I/O",
      async (target, change) => {
        const id = await seed();
        const pages: number[] = [];
        const source = registration({
          list: async ({ page }) => {
            pages.push(page);
            if (change === "erasure") {
              await db
                .update(caseLawDecisions)
                .set({
                  redactedAt: clock,
                  fulltext: null,
                  sections: null,
                  documentAst: null,
                  contentHash: null,
                })
                .where(eq(caseLawDecisions.id, id));
            } else {
              await db
                .update(caseLawDecisions)
                .set({
                  fulltext: "New source observation",
                  sourceHash: "b".repeat(64),
                  sourceObservationOrder: 2n,
                })
                .where(eq(caseLawDecisions.id, id));
            }
            return {
              totalPages: 6,
              items:
                target === "build"
                  ? [
                      {
                        identity: {
                          type: "document",
                          sourceDocumentId: documentId,
                        },
                        payload: {},
                      },
                    ]
                  : [],
            };
          },
          build: async () => ({ type: "built", decision: candidate() }),
        });
        await run({ registration: source });
        expect(pages).toEqual([0]);
        expect(publisherCalls).toBe(1);
        expect(builds).toBe(0);
        const held = await rowOf(id);
        if (change === "erasure") {
          expect(held.textState).toBeNull();
        } else {
          expect(held.sourceHash).toBe("b".repeat(64));
          expect(held.fulltext).toBe("New source observation");
          expect(held.textState?.status).not.toBe("stored");
        }
      },
    );
    test("a failed unit reports the original invariant error and releases its source lease", async () => {
      await db
        .update(caseLawSources)
        .set({ adapterKey: ADAPTER_KEYS.CZ_NSS })
        .where(eq(caseLawSources.id, sourceId));
      const outcome = await run();
      expect(outcome).toMatchObject({
        type: "failed",
        error: {
          _tag: "Panic",
          message: "Full-text worker source does not match its adapter",
        },
      });
      const source = (
        await db
          .select({ token: caseLawSources.ingestionLeaseToken })
          .from(caseLawSources)
          .where(eq(caseLawSources.id, sourceId))
      ).at(0);
      expect(source?.token).toBeNull();
      expect(publisherCalls).toBe(0);
    });
  },
);
