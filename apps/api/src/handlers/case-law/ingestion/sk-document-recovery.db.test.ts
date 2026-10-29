import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { DECISION_TEXT_FAILURE } from "@stll/api-contract/case-law-fulltext-state";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { pendingDecisionText } from "@/api/lib/case-law/fulltext-state";
import { claimDecisionTextWork } from "@/api/lib/case-law/fulltext-state-store";
import { readPresent } from "@/api/lib/errors/read-outcome";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import {
  claimDocumentFetch,
  DOCUMENT_FETCH_FAILURE,
  fetchDecisionDocument,
  storeBackfilledDocument,
} from "@/api/lib/legal-search/sk-document-backfill";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const sourceId = createSafeId<"caseLawSource">();
const now = new Date("2026-10-30T12:00:00.000Z");
let client: Awaited<ReturnType<typeof createTestPglite>>;
const connect = (connection: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({ client: connection });
let db: ReturnType<typeof connect>;
const scopedDb: ScopedDb = async (run) =>
  await db.transaction(async (tx) => await run(asTestRaw(tx)));
beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);
  await db.insert(caseLawSources).values(
    caseLawSourceRow({
      id: sourceId,
      adapterKey: ADAPTER_KEYS.SK_COURTS,
      enabled: true,
    }),
  );
});
afterAll(async () => {
  await client.close();
});

const ast = {
  version: 1,
  source: {
    system: "obcan.justice.sk",
    documentId: "recovered",
    webUrl: "https://obcan.justice.sk/fixture",
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
      id: "body",
      anchorId: "body",
      type: "paragraph",
      plainText: "Súd rozhodol vo veci.",
      inlines: [{ type: "text", text: "Súd rozhodol vo veci." }],
    },
  ],
} satisfies DocumentAst;
const document = {
  fulltext: "Súd rozhodol vo veci.",
  documentAst: ast,
  sections: [],
};
const identityColumns = {
  textState: caseLawDecisions.textState,
  sourceHash: caseLawDecisions.sourceHash,
  sourceObservationOrder: caseLawDecisions.sourceObservationOrder,
  contentHash: caseLawDecisions.contentHash,
  textS3Key: caseLawDecisions.textS3Key,
  normalizedS3Key: caseLawDecisions.normalizedS3Key,
  astS3Key: caseLawDecisions.astS3Key,
};
const seedTarget = async () => {
  const id = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values({
    id,
    sourceId,
    sourceDocumentId: id,
    country: "SVK",
    language: "sk",
    court: "Okresný súd",
    caseNumber: "1T/1/2026",
    slug: id,
    documentUrl: "https://obcan.justice.sk/fixture.pdf",
    sourceHash: "a".repeat(64),
    contentHash: "b".repeat(64),
    textS3Key: "legal-corpus/missing/text.zst",
    normalizedS3Key: "legal-corpus/missing/sections.json.zst",
    astS3Key: "legal-corpus/missing/ast.json.zst",
    textState: pendingDecisionText({
      now,
      delayMs: 0,
      attemptCount: 0,
      lastAttemptAt: null,
    }),
  });
  const target = (
    await claimDecisionTextWork({ scopedDb, sourceId, now })
  ).find((row) => row.id === id);
  if (target === undefined) {
    throw new TypeError("Expected a text recovery claim");
  }
  const claim = await claimDocumentFetch(id, scopedDb);
  if (claim.status !== "claimed") {
    throw new TypeError("Expected a deferred document claim");
  }
  return { target, decision: claim.decision };
};

test("only a matching recovery target can replace an unreadable canonical payload", async () => {
  const { target, decision } = await seedTarget();
  const before = await db
    .select(identityColumns)
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, decision.id));
  expect(
    await storeBackfilledDocument({
      decision,
      document,
      scopedDb,
      mode: "canonical",
      transfer: null,
    }),
  ).toBe("superseded");
  expect(
    await db
      .select(identityColumns)
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, decision.id)),
  ).toEqual(before);
  const outcome = await storeBackfilledDocument({
    decision,
    document,
    scopedDb,
    mode: "canonical",
    recoveryTarget: target,
    transfer: { layout: "packs", putPacks: async () => Result.ok(undefined) },
  });
  expect(outcome).toBe("stored");
  const stored = (
    await db
      .select({
        ...identityColumns,
        fulltext: caseLawDecisions.fulltext,
        documentAst: caseLawDecisions.documentAst,
      })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, decision.id))
  ).at(0);
  expect(stored?.textS3Key).toStartWith("pack:");
  expect(stored?.normalizedS3Key).toStartWith("pack:");
  expect(stored?.astS3Key).toStartWith("pack:");
  expect(stored?.contentHash).not.toBe(target.contentHash);
  expect(stored?.textState).toMatchObject({
    status: "stored",
    storage: "corpus",
    contentHash: stored?.contentHash,
  });
  expect(stored?.fulltext).toBeNull();
  expect(stored?.documentAst).toBeNull();
});

const concurrentChanges = [
  {
    name: "state",
    patch: {
      textState: pendingDecisionText({
        now,
        delayMs: 1000,
        attemptCount: 9,
        lastAttemptAt: null,
      }),
    },
  },
  { name: "source hash", patch: { sourceHash: "c".repeat(64) } },
  { name: "observation order", patch: { sourceObservationOrder: 42n } },
  { name: "content hash", patch: { contentHash: "d".repeat(64) } },
  { name: "text pointer", patch: { textS3Key: "legal-corpus/new/text.zst" } },
  {
    name: "sections pointer",
    patch: { normalizedS3Key: "legal-corpus/new/sections.json.zst" },
  },
  { name: "AST pointer", patch: { astS3Key: "legal-corpus/new/ast.json.zst" } },
] as const;

test.each(concurrentChanges)(
  "a newer $name wins over a recovery upload",
  async ({ patch }) => {
    const { target, decision } = await seedTarget();
    const snapshot = async () =>
      await db
        .select(identityColumns)
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decision.id));
    let newer: Awaited<ReturnType<typeof snapshot>> | undefined;
    const outcome = await storeBackfilledDocument({
      decision,
      document,
      scopedDb,
      mode: "canonical",
      recoveryTarget: target,
      transfer: {
        layout: "packs",
        putPacks: async () => {
          await db
            .update(caseLawDecisions)
            .set(patch)
            .where(eq(caseLawDecisions.id, decision.id));
          newer = await snapshot();
          return Result.ok(undefined);
        },
      },
    });
    expect(newer).toBeDefined();
    if (newer === undefined) {
      throw new TypeError("Recovery upload must exercise the concurrent write");
    }
    expect(outcome).toBe("superseded");
    expect(await snapshot()).toEqual(newer);
  },
);

test("recovery returns the parser failure to its fenced state owner", async () => {
  const { target, decision } = await seedTarget();
  await db
    .update(caseLawDecisions)
    .set({
      documentFetchAttemptedAt: null,
      documentUrl: "https://obcan.justice.sk/content/public/item/fixture.pdf",
    })
    .where(eq(caseLawDecisions.id, decision.id));
  const fetched = await Result.tryPromise({
    try: async () =>
      await fetchDecisionDocument({
        decisionId: decision.id,
        recoveryTarget: target,
        scopedDb,
        signal: new AbortController().signal,
        fetchDocument: async () =>
          readPresent(new Response("<html>Publisher error page</html>")),
        checkRetention: () => undefined,
      }),
    catch: (error) => error,
  });
  expect(fetched.isOk()).toBe(true);
  if (fetched.isOk()) {
    expect(fetched.value).toMatchObject({
      status: "deferred",
      failure: DOCUMENT_FETCH_FAILURE.UNPARSEABLE,
      cause: {
        kind: DECISION_TEXT_FAILURE.PARSER_REFUSAL,
        code: "AdapterFetchError",
      },
    });
  }
  const stored = (
    await db
      .select(identityColumns)
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, decision.id))
  ).at(0);
  expect(stored?.textState).toEqual(target.textState);
});
