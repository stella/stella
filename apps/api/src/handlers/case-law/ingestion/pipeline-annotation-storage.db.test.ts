import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { isDocumentAst } from "@stll/legal-ast/document-ast";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { extractDecisionCitations } from "@/api/handlers/case-law/ingestion/citation-extractor";
import {
  CITATION_SCOPE_METADATA_KEY,
  CitationScopesRejectedError,
  citationScopeAstHash,
  citationScopeEnvelope,
  validatedCitationScopes,
} from "@/api/handlers/case-law/ingestion/citation-scopes";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import { PROCESS_DECISION_STATUS } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { DECISION_REFRESH } from "@/api/handlers/case-law/ingestion/pipeline/types";
import { createSafeId } from "@/api/lib/branded-types";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import { zstdDecompressToStringBounded } from "@/api/lib/compression";
import { parseCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import type { EncodedPack } from "@/api/lib/legal-search/corpus-pack";
import { sanitizeResult } from "@/api/lib/legal-search/ingestion-normalization";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;
const sourceId = createSafeId<"caseLawSource">();
const packs: EncodedPack[] = [];

const packedCorpus = {
  mode: "canonical",
  transfer: {
    layout: "packs",
    putPacks: async ({ packs: written }) => {
      packs.push(...written);
      return await Promise.resolve(Result.ok(undefined));
    },
  },
  readBytes: {
    readRange: async ({ key, offset, length }) => {
      const pack = packs.find(({ packKey }) => packKey === key);
      if (!pack) {
        throw new Error(`Pack not found: ${key}`);
      }
      return pack.bytes.slice(offset, offset + length);
    },
  },
} satisfies CaseLawCorpusDependencies;

const inlineCorpus = {
  mode: "off",
  transfer: {
    layout: "packs",
    putPacks: () => {
      throw new TypeError("Inline mode must not transfer packs");
    },
  },
} satisfies CaseLawCorpusDependencies;

const opinion = [
  {
    opinionId: "majority",
    blockIds: ["p1"],
    boundaries: "proven",
  },
] as const;

const sourceText = "\u0000See\u00a0347 U.S. 483. Id. at 495.";
const sourceAst = (documentId: string, body = sourceText): DocumentAst => ({
  version: 1,
  source: { system: "test", documentId, webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      id: "p1",
      anchorId: "p1",
      type: "paragraph",
      inlines: [{ type: "text", text: body }],
      plainText: body,
    },
  ],
});

const input = (documentId: string, body = sourceText): IngestionResult =>
  plainTextIngestionResult({
    caseNumber: `No. ${documentId}`,
    sourceDocumentId: documentId,
    court: "Supreme Court of the United States",
    courtId: "scotus",
    country: "USA",
    language: "en",
    decisionDate: "2024-03-01",
    fulltext: body,
    metadata: {},
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    rawHash: `raw-${documentId}`,
    documentAst: sourceAst(documentId, body),
    citationScopes: opinion,
  });

test.each(["SVK", "CZE"])(
  "%s rejects invalid opinion scopes before storing their envelope",
  async (country) => {
    const documentId = createSafeId<"caseLawDecision">();
    const failed = await Result.tryPromise({
      try: async () =>
        await processDecision({
          input: plainTextIngestionResult({
            ...input(documentId),
            country,
            courtId: undefined,
            citationScopes: [
              {
                opinionId: "majority",
                blockIds: ["missing-block"],
                boundaries: "proven",
              },
            ],
          }),
          sourceId,
          scopedDb,
          observedAt: new Date("2026-09-27T12:00:00.000Z"),
          observationOrder: 1n,
          corpus: inlineCorpus,
        }),
      catch: (cause) => cause,
    });
    if (!Result.isError(failed)) {
      expect.unreachable(
        "A missing block must reject the incoming scope envelope",
      );
    }
    expect(failed.error).toBeInstanceOf(CitationScopesRejectedError);
    if (!(failed.error instanceof CitationScopesRejectedError)) {
      expect.unreachable("Scope rejection retains its structured error");
    }
    expect(failed.error.defect).toBe("unknown-block");
    const rows = await db
      .select()
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.sourceDocumentId, documentId));
    expect(rows).toHaveLength(0);
  },
);

const storedAst = async (pack: EncodedPack, decisionId: string) => {
  const entry = pack.entries.find(
    ({ member }) => member.documentId === decisionId && member.kind === "ast",
  );
  if (!entry) {
    throw new Error("Pack lacks the decision AST member");
  }
  const { offset, length } = entry.member;
  const decoded = await zstdDecompressToStringBounded(
    pack.bytes.slice(offset, offset + length),
    10 * 1024 * 1024,
  );
  return JSON.parse(decoded);
};

const runBeforeQuery = <T extends object>(
  target: T,
  before: () => Promise<void>,
): T =>
  new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key);
      if (typeof value !== "function") {
        return value;
      }
      if (key === "then") {
        return async (
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => {
          await before();
          return await Reflect.apply(value, object, [onFulfilled, onRejected]);
        };
      }
      return (...args: unknown[]) => {
        const out: unknown = Reflect.apply(value, object, args);
        return typeof out === "object" && out !== null
          ? runBeforeQuery(out, before)
          : out;
      };
    },
  });

const wrapLockedSelect = <T extends object>(
  target: T,
  before: () => Promise<void>,
): T =>
  new Proxy(target, {
    get(object, key) {
      const method: unknown = Reflect.get(object, key);
      if (typeof method !== "function") {
        return method;
      }
      if (key === "then") {
        return method.bind(object);
      }
      return (...args: unknown[]) => {
        const out: unknown = Reflect.apply(method, object, args);
        if (typeof out !== "object" || out === null) {
          return out;
        }
        return key === "for"
          ? runBeforeQuery(out, before)
          : wrapLockedSelect(out, before);
      };
    },
  });

/** Publish one competing document after the plan read, before its row lock. */
const withDocumentWinner = (
  winner: (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  ) => Promise<void>,
): ScopedDb => {
  let pending = true;
  return async (callback) =>
    await db.transaction(async (tx) => {
      const racing = new Proxy(tx, {
        get(object, key) {
          const value: unknown = Reflect.get(object, key);
          if (key === "select" && typeof value === "function") {
            return (...args: unknown[]) => {
              const builder: unknown = Reflect.apply(value, object, args);
              if (typeof builder !== "object" || builder === null) {
                return builder;
              }
              return wrapLockedSelect(builder, async () => {
                if (pending) {
                  pending = false;
                  await winner(tx);
                }
              });
            };
          }
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
      return await callback(asTestRaw(racing));
    });
};

/** Publish a competing document after identity resolution, before scope reuse. */
const withScopeReadWinner = (
  winner: (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  ) => Promise<void>,
): ScopedDb => {
  let pending = true;
  return async (callback) =>
    await db.transaction(async (tx) => {
      const racing = new Proxy(tx, {
        get(object, key) {
          const value: unknown = Reflect.get(object, key);
          if (key === "select" && typeof value === "function") {
            return (...args: unknown[]) => {
              const builder: unknown = Reflect.apply(value, object, args);
              const fields = args.at(0);
              if (
                !pending ||
                typeof fields !== "object" ||
                fields === null ||
                !("documentAst" in fields) ||
                !("astS3Key" in fields) ||
                !("metadata" in fields) ||
                typeof builder !== "object" ||
                builder === null
              ) {
                return builder;
              }
              return runBeforeQuery(builder, async () => {
                pending = false;
                await winner(tx);
              });
            };
          }
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
      return await callback(asTestRaw(racing));
    });
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client, relations: { ...relations, ...authRelationsPart } });
  scopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `annotation-storage-${sourceId}`,
    name: "Annotation storage test",
  });
});

afterAll(async () => {
  await client.close();
});

test.each([
  ["inline Postgres", inlineCorpus],
  ["packed corpus", packedCorpus],
] as const)(
  "persists annotated AST and verified scope through %s",
  async (_name, corpus) => {
    const documentId = createSafeId<"caseLawDecision">();
    const outcome = await processDecision({
      input: input(documentId),
      observationOrder: 1n,
      sourceId,
      scopedDb,
      observedAt: new Date("2026-09-27T12:00:00.000Z"),
      refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
      corpus,
    });
    expect(outcome.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);

    const row =
      (
        await db
          .select({
            id: caseLawDecisions.id,
            metadata: caseLawDecisions.metadata,
            documentAst: caseLawDecisions.documentAst,
            astS3Key: caseLawDecisions.astS3Key,
          })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.sourceDocumentId, documentId))
      ).at(0) ?? expect.unreachable();

    const documentAst =
      corpus.mode === "off"
        ? row.documentAst
        : await storedAst(packs.at(-1) ?? expect.unreachable(), row.id);
    expect(isDocumentAst(documentAst)).toBe(true);
    if (!isDocumentAst(documentAst)) {
      throw new Error("Stored document must be a valid AST");
    }
    if (corpus.mode === "canonical") {
      expect(row.documentAst).toBeNull();
      expect(
        parseCorpusLocation(row.astS3Key ?? expect.unreachable()).type,
      ).toBe("packed");
    }
    const envelope = (row.metadata ?? expect.unreachable())[
      CITATION_SCOPE_METADATA_KEY
    ];
    expect(envelope).toMatchObject({ version: 1, opinions: opinion });
    const verified = validatedCitationScopes(
      row.metadata ?? expect.unreachable(),
      documentAst,
    );
    if (Result.isError(verified)) {
      throw verified.error;
    }
    expect(verified.value).toEqual(opinion);
    expect(envelope).toMatchObject({
      astHash: citationScopeAstHash(documentAst),
    });

    const paragraph = documentAst.blocks.at(0);
    expect(paragraph?.type === "paragraph" ? paragraph.plainText : null).toBe(
      "See 347 U.S. 483. Id. at 495.",
    );
    if (paragraph?.type !== "paragraph") {
      throw new Error("Stored document must retain its paragraph");
    }
    expect(paragraph.inlines.some((inline) => inline.type === "citation")).toBe(
      true,
    );
    const reparsed = extractDecisionCitations({
      country: "USA",
      sections: [],
      documentAst,
      citationScopes: verified.value,
    });
    if (Result.isError(reparsed)) {
      throw reparsed.error;
    }
    expect(reparsed.value.documentAst).toEqual(documentAst);

    if (corpus.mode === "canonical") {
      const { citationScopes: _scopes, ...withoutScopes } = input(documentId);
      const refreshed = await processDecision({
        input: {
          ...withoutScopes,
          rawHash: `raw-${documentId}-refresh`,
          fulltext: undefined,
          documentAst: {},
          metadata: { refreshed: true },
        },
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-09-27T12:00:01.000Z"),
        refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
        corpus,
      });
      expect(refreshed.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
      const after =
        (
          await db
            .select({
              metadata: caseLawDecisions.metadata,
              documentAst: caseLawDecisions.documentAst,
              astS3Key: caseLawDecisions.astS3Key,
            })
            .from(caseLawDecisions)
            .where(eq(caseLawDecisions.id, row.id))
        ).at(0) ?? expect.unreachable();
      expect(after.metadata).toMatchObject({
        refreshed: true,
        [CITATION_SCOPE_METADATA_KEY]: envelope,
      });
      expect(after.documentAst).toBeNull();
      expect(after.astS3Key).toBe(row.astS3Key);
      const retainedAst = await storedAst(
        packs.at(-1) ?? expect.unreachable(),
        row.id,
      );
      const retained = validatedCitationScopes(
        after.metadata ?? expect.unreachable(),
        retainedAst,
      );
      if (Result.isError(retained)) {
        throw retained.error;
      }
      expect(retained.value).toEqual(opinion);
    }
  },
);

test("a changed document and its replay retain annotations without graph rows", async () => {
  const documentId = createSafeId<"caseLawDecision">();
  const first = input(documentId);
  const changed = plainTextIngestionResult({
    ...input(documentId, `${sourceText} See 347 U.S. 483.`),
    rawHash: `${first.rawHash}-changed`,
  });
  for (const [order, observation] of [first, changed, changed].entries()) {
    const outcome = await processDecision({
      input: observation,
      observationOrder: BigInt(order + 1),
      sourceId,
      scopedDb,
      observedAt: new Date(`2026-09-27T12:00:0${order}.000Z`),
      refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
      corpus: inlineCorpus,
    });
    expect(outcome.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
  }

  const row =
    (
      await db
        .select({
          id: caseLawDecisions.id,
          documentAst: caseLawDecisions.documentAst,
          metadata: caseLawDecisions.metadata,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceDocumentId, documentId))
    ).at(0) ?? expect.unreachable();
  const verified = validatedCitationScopes(
    row.metadata ?? expect.unreachable(),
    row.documentAst,
  );
  if (Result.isError(verified)) {
    throw verified.error;
  }
  expect(verified.value).toEqual(opinion);
  if (!isDocumentAst(row.documentAst)) {
    throw new Error("Changed document must retain its AST");
  }
  const paragraph = row.documentAst.blocks.at(0);
  expect(
    paragraph?.type === "paragraph"
      ? paragraph.inlines.filter((inline) => inline.type === "citation").length
      : null,
  ).toBeGreaterThanOrEqual(3);
  expect(
    await db
      .select({ id: caseLawCitations.id })
      .from(caseLawCitations)
      .where(eq(caseLawCitations.citingDecisionId, row.id)),
  ).toHaveLength(0);
});

test("a metadata-only refresh preserves the stored AST and its scope envelope", async () => {
  const documentId = createSafeId<"caseLawDecision">();
  const first = input(documentId);
  const initial = await processDecision({
    input: first,
    observationOrder: 1n,
    sourceId,
    scopedDb,
    observedAt: new Date("2026-09-27T12:00:00.000Z"),
    refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
    corpus: inlineCorpus,
  });
  expect(initial.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
  const before =
    (
      await db
        .select({
          metadata: caseLawDecisions.metadata,
          documentAst: caseLawDecisions.documentAst,
          sourceHash: caseLawDecisions.sourceHash,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceDocumentId, documentId))
    ).at(0) ?? expect.unreachable();

  const { citationScopes: _scopes, ...withoutScopes } = first;
  const refreshed = await processDecision({
    input: {
      ...withoutScopes,
      rawHash: `${first.rawHash}-refresh`,
      fulltext: undefined,
      documentAst: {},
      metadata: { refreshed: true },
    },
    observationOrder: 2n,
    sourceId,
    scopedDb,
    observedAt: new Date("2026-09-27T12:00:01.000Z"),
    refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
    corpus: inlineCorpus,
  });
  expect(refreshed.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
  const after =
    (
      await db
        .select({
          metadata: caseLawDecisions.metadata,
          documentAst: caseLawDecisions.documentAst,
          sourceHash: caseLawDecisions.sourceHash,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceDocumentId, documentId))
    ).at(0) ?? expect.unreachable();
  expect(after.sourceHash).not.toBe(before.sourceHash);
  expect(after.documentAst).toEqual(before.documentAst);
  expect(after.metadata).toMatchObject({
    refreshed: true,
    [CITATION_SCOPE_METADATA_KEY]: (before.metadata ?? expect.unreachable())[
      CITATION_SCOPE_METADATA_KEY
    ],
  });
  const checked = validatedCitationScopes(
    after.metadata ?? expect.unreachable(),
    after.documentAst,
  );
  if (Result.isError(checked)) {
    throw checked.error;
  }
  expect(checked.value).toEqual(opinion);
});

test("a metadata-only refresh rejects a stored scope whose AST hash is stale", async () => {
  const documentId = createSafeId<"caseLawDecision">();
  const first = input(documentId);
  await processDecision({
    input: first,
    observationOrder: 1n,
    sourceId,
    scopedDb,
    observedAt: new Date("2026-09-27T12:00:00.000Z"),
    refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
    corpus: inlineCorpus,
  });
  const before =
    (
      await db
        .select({
          id: caseLawDecisions.id,
          metadata: caseLawDecisions.metadata,
          sourceHash: caseLawDecisions.sourceHash,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceDocumentId, documentId))
    ).at(0) ?? expect.unreachable();
  const envelope = (before.metadata ?? expect.unreachable())[
    CITATION_SCOPE_METADATA_KEY
  ];
  if (typeof envelope !== "object" || envelope === null) {
    throw new Error("Initial row must have a scope envelope");
  }
  await db
    .update(caseLawDecisions)
    .set({
      metadata: {
        ...before.metadata,
        [CITATION_SCOPE_METADATA_KEY]: { ...envelope, astHash: "0".repeat(64) },
      },
    })
    .where(eq(caseLawDecisions.id, before.id));

  const { citationScopes: _scopes, ...withoutScopes } = first;
  const rejection: unknown = await processDecision({
    input: {
      ...withoutScopes,
      rawHash: `${first.rawHash}-refresh`,
      fulltext: undefined,
      documentAst: {},
      metadata: { refreshed: true },
    },
    observationOrder: 2n,
    sourceId,
    scopedDb,
    observedAt: new Date("2026-09-27T12:00:01.000Z"),
    refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
    corpus: inlineCorpus,
  }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(rejection).toMatchObject({
    defect: "ast-hash-mismatch",
    message: expect.stringContaining("ast-hash-mismatch"),
  });
  const after =
    (
      await db
        .select({ sourceHash: caseLawDecisions.sourceHash })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, before.id))
    ).at(0) ?? expect.unreachable();
  expect(after.sourceHash).toBe(before.sourceHash);
});

test("a metadata refresh retries when a full document wins before the row lock", async () => {
  const documentId = createSafeId<"caseLawDecision">();
  const full = input(documentId);
  const { citationScopes: _scopes, ...withoutScopes } = full;
  const listing = {
    ...withoutScopes,
    fulltext: undefined,
    documentAst: {},
  };
  await processDecision({
    input: listing,
    observationOrder: 1n,
    sourceId,
    scopedDb,
    observedAt: new Date("2026-09-27T12:00:00.000Z"),
    refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
    corpus: inlineCorpus,
  });
  const stored =
    (
      await db
        .select({ id: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceDocumentId, documentId))
    ).at(0) ?? expect.unreachable();
  const sanitized = sanitizeResult(full);
  if (!isDocumentAst(sanitized.documentAst)) {
    throw new Error("Winner fixture must have a sanitized AST");
  }
  const extracted = extractDecisionCitations({
    country: "USA",
    sections: [],
    documentAst: sanitized.documentAst,
    citationScopes: opinion,
  });
  if (Result.isError(extracted)) {
    throw extracted.error;
  }
  const winningAst = extracted.value.documentAst ?? expect.unreachable();
  const winningEnvelope = citationScopeEnvelope(winningAst, opinion);
  let published = false;
  const racing = withDocumentWinner(async (tx) => {
    published = true;
    await tx
      .update(caseLawDecisions)
      .set({
        documentAst: winningAst,
        fulltext: "See 347 U.S. 483. Id. at 495.",
        metadata: { [CITATION_SCOPE_METADATA_KEY]: winningEnvelope },
      })
      .where(eq(caseLawDecisions.id, stored.id));
  });

  const refreshed = await processDecision({
    input: {
      ...listing,
      rawHash: `${full.rawHash}-refresh`,
      metadata: { refreshed: true },
    },
    observationOrder: 2n,
    sourceId,
    scopedDb: racing,
    observedAt: new Date("2026-09-27T12:00:01.000Z"),
    refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
    corpus: inlineCorpus,
  });
  expect(published).toBe(true);
  expect(refreshed.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
  const after =
    (
      await db
        .select({
          metadata: caseLawDecisions.metadata,
          documentAst: caseLawDecisions.documentAst,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, stored.id))
    ).at(0) ?? expect.unreachable();
  expect(after.documentAst).toEqual(winningAst);
  expect(after.metadata).toMatchObject({
    refreshed: true,
    [CITATION_SCOPE_METADATA_KEY]: winningEnvelope,
  });
  const checked = validatedCitationScopes(
    after.metadata ?? expect.unreachable(),
    after.documentAst,
  );
  if (Result.isError(checked)) {
    throw checked.error;
  }
  expect(checked.value).toEqual(opinion);
});

test("a metadata refresh retries when a document wins before the scope read", async () => {
  const documentId = createSafeId<"caseLawDecision">();
  const first = input(documentId);
  await processDecision({
    input: first,
    observationOrder: 1n,
    sourceId,
    scopedDb,
    observedAt: new Date("2026-09-27T12:00:00.000Z"),
    refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
    corpus: inlineCorpus,
  });
  const stored =
    (
      await db
        .select({
          id: caseLawDecisions.id,
          metadata: caseLawDecisions.metadata,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceDocumentId, documentId))
    ).at(0) ?? expect.unreachable();
  const winning = input(documentId, `${sourceText} See 410 U.S. 113.`);
  const sanitized = sanitizeResult(winning);
  if (!isDocumentAst(sanitized.documentAst)) {
    throw new Error("Winner fixture must have a sanitized AST");
  }
  const extracted = extractDecisionCitations({
    country: "USA",
    sections: [],
    documentAst: sanitized.documentAst,
    citationScopes: opinion,
  });
  if (Result.isError(extracted)) {
    throw extracted.error;
  }
  const winningAst = extracted.value.documentAst ?? expect.unreachable();
  const winningEnvelope = citationScopeEnvelope(winningAst, opinion);
  expect(winningEnvelope).not.toEqual(
    (stored.metadata ?? expect.unreachable())[CITATION_SCOPE_METADATA_KEY],
  );
  let published = false;
  const racing = withScopeReadWinner(async (tx) => {
    published = true;
    await tx
      .update(caseLawDecisions)
      .set({
        documentAst: winningAst,
        fulltext: sanitized.fulltext,
        metadata: { [CITATION_SCOPE_METADATA_KEY]: winningEnvelope },
      })
      .where(eq(caseLawDecisions.id, stored.id));
  });
  const { citationScopes: _scopes, ...withoutScopes } = first;
  const refreshed = await processDecision({
    input: {
      ...withoutScopes,
      rawHash: `${first.rawHash}-refresh`,
      fulltext: undefined,
      documentAst: {},
      metadata: { refreshed: true },
    },
    observationOrder: 2n,
    sourceId,
    scopedDb: racing,
    observedAt: new Date("2026-09-27T12:00:01.000Z"),
    refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
    corpus: inlineCorpus,
  });
  expect(published).toBe(true);
  expect(refreshed.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
  const after =
    (
      await db
        .select({
          documentAst: caseLawDecisions.documentAst,
          metadata: caseLawDecisions.metadata,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, stored.id))
    ).at(0) ?? expect.unreachable();
  expect(after.documentAst).toEqual(winningAst);
  expect(after.metadata).toMatchObject({
    refreshed: true,
    [CITATION_SCOPE_METADATA_KEY]: winningEnvelope,
  });
});
