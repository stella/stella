/**
 * A write that replaces a decision's document records where every anchor the
 * old document held went: to the block that holds its words now, or nowhere.
 * Covered: a reworded and a split paragraph, a chain of rewrites (one hop),
 * a removed paragraph, a legacy row with positional anchors meeting stable
 * ones, the canonical store (old document read from object storage), and the
 * public read the redirect route answers from.
 */
import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { DECISION_ANCHOR_REDIRECT } from "@stll/api-contract/case-law-anchor-redirects";
import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";
import { isDocumentAst } from "@stll/legal-ast/document-ast";
import { blockAnchorText } from "@stll/legal-ast/stable-block-anchors";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisionAnchorRedirects,
  caseLawDecisions,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import { PROCESS_DECISION_STATUS } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { DECISION_REFRESH } from "@/api/handlers/case-law/ingestion/pipeline/types";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { readDecisionAnchorRedirects } from "@/api/lib/case-law/decision-anchor-redirects";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { zstdDecompressToStringBounded } from "@/api/lib/compression";
import type { EncodedPack } from "@/api/lib/legal-search/corpus-pack";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;
const sourceId = createSafeId<"caseLawSource">();
const packs: EncodedPack[] = [];

const inlineCorpus = {
  mode: "off",
  transfer: {
    layout: "packs",
    putPacks: () => {
      throw new TypeError("Inline mode must not transfer packs");
    },
  },
} satisfies CaseLawCorpusDependencies;

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
      return await Promise.resolve(pack.bytes.slice(offset, offset + length));
    },
  },
} satisfies CaseLawCorpusDependencies;

const A = "Soud prvního stupně žalobu zamítl, neboť žalobce neunesl břemeno.";
const B =
  "Odvolací soud rozsudek soudu prvního stupně potvrdil v plném rozsahu.";
const C =
  "Dovolání není přípustné. Napadené rozhodnutí je v souladu s judikaturou dovolacího soudu.";

const paragraph = (text: string, ordinal: number): Block => ({
  id: `b${String(ordinal)}`,
  anchorId: `p-${String(ordinal)}`,
  type: "paragraph",
  inlines: [{ type: "text", text }],
  plainText: text,
});

/** A parse as a parser emits it: positional anchors, one per paragraph. */
const documentOf = (documentId: string, texts: readonly string[]) =>
  ({
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
    blocks: texts.map((text, index) => paragraph(text, index + 1)),
  }) satisfies DocumentAst;

const input = (
  documentId: string,
  rawHash: string,
  texts: readonly string[],
): IngestionResult =>
  plainTextIngestionResult({
    caseNumber: `22 Cdo ${documentId.slice(-6)}/2026`,
    sourceDocumentId: documentId,
    court: "Nejvyšší soud",
    country: "CZE",
    language: "cs",
    decisionDate: "2026-03-01",
    decisionType: "usnesení",
    fulltext: texts.join("\n\n"),
    metadata: {},
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    rawHash,
    documentAst: documentOf(documentId, texts),
  });

let order = 0n;
const ingest = async (
  documentId: string,
  texts: readonly string[],
  corpus: CaseLawCorpusDependencies = inlineCorpus,
) => {
  order += 1n;
  const outcome = (
    await processDecision({
      input: input(documentId, `raw-${String(order)}`, texts),
      sourceId,
      scopedDb,
      observedAt: new Date(Date.UTC(2026, 10, 10, 12, 0, Number(order))),
      observationOrder: order,
      refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
      corpus,
    })
  ).unwrap();
  expect(outcome.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
};

const decisionIdOf = async (
  documentId: string,
): Promise<SafeId<"caseLawDecision">> => {
  const row = (
    await db
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.sourceDocumentId, documentId))
  ).at(0);
  if (row === undefined) {
    throw new Error(`decision ${documentId} was not stored`);
  }
  return row.id;
};

/** The stored document of an inline row. */
const inlineDocument = async (
  decisionId: SafeId<"caseLawDecision">,
): Promise<DocumentAst> => {
  const row = (
    await db
      .select({ documentAst: caseLawDecisions.documentAst })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, decisionId))
  ).at(0);
  if (!isDocumentAst(row?.documentAst)) {
    throw new Error("expected a stored document");
  }
  return row.documentAst;
};

/** The stored document of a canonical row, out of the last pack holding it. */
const packedDocument = async (
  decisionId: SafeId<"caseLawDecision">,
): Promise<DocumentAst> => {
  const entry = packs
    .flatMap((pack) =>
      pack.entries.map((candidate) => ({ pack, member: candidate.member })),
    )
    .findLast(
      ({ member }) => member.documentId === decisionId && member.kind === "ast",
    );
  if (entry === undefined) {
    throw new Error("no pack holds the decision document");
  }
  const { offset, length } = entry.member;
  const parsed: unknown = JSON.parse(
    await zstdDecompressToStringBounded(
      entry.pack.bytes.slice(offset, offset + length),
      10 * 1024 * 1024,
    ),
  );
  if (!isDocumentAst(parsed)) {
    throw new Error("expected a packed document");
  }
  return parsed;
};

const anchorOf = (ast: DocumentAst, text: string): string => {
  const block = ast.blocks.find((candidate) => candidate.plainText === text);
  if (block === undefined) {
    throw new Error(`no block holds ${text}`);
  }
  return block.anchorId;
};

const textOf = (ast: DocumentAst, anchor: string): string => {
  const block = ast.blocks.find((candidate) => candidate.anchorId === anchor);
  if (block === undefined) {
    throw new Error(`no block ${anchor}`);
  }
  return blockAnchorText(block);
};

const redirectsOf = async (
  decisionId: SafeId<"caseLawDecision">,
): Promise<Map<string, string | null>> =>
  new Map(
    (
      await db
        .select({
          fromAnchor: caseLawDecisionAnchorRedirects.fromAnchor,
          toAnchor: caseLawDecisionAnchorRedirects.toAnchor,
        })
        .from(caseLawDecisionAnchorRedirects)
        .where(eq(caseLawDecisionAnchorRedirects.decisionId, decisionId))
    ).map(({ fromAnchor, toAnchor }) => [fromAnchor, toAnchor]),
  );

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client, relations: { ...relations, ...authRelationsPart } });
  scopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: "anchor-redirects-test",
    name: "Anchor redirects test",
  });
});

afterAll(async () => {
  await client.close();
});

test("a reworded and a split paragraph redirect to the blocks holding their words", async () => {
  const documentId = createSafeId<"caseLawDecision">();
  await ingest(documentId, [A, B, C]);
  const decisionId = await decisionIdOf(documentId);
  const v1 = await inlineDocument(decisionId);
  expect(await redirectsOf(decisionId)).toEqual(new Map());

  const reworded = `${B} Náklady řízení nebyly přiznány.`;
  const splitAt = C.indexOf(" Napadené");
  await ingest(documentId, [
    A,
    reworded,
    C.slice(0, splitAt),
    C.slice(splitAt + 1),
  ]);
  const v2 = await inlineDocument(decisionId);

  expect(await redirectsOf(decisionId)).toEqual(
    new Map([
      [anchorOf(v1, B), anchorOf(v2, reworded)],
      [anchorOf(v1, C), anchorOf(v2, C.slice(0, splitAt))],
    ]),
  );
  // The unchanged paragraph kept its anchor and needs no redirect.
  expect(anchorOf(v2, A)).toBe(anchorOf(v1, A));
});

test("a second rewrite keeps every redirect one hop, and a removed paragraph is gone", async () => {
  const documentId = createSafeId<"caseLawDecision">();
  const B2 = `${B} Náklady řízení nebyly přiznány.`;
  const B3 = `${B2} Rozhodnutí je pravomocné.`;
  await ingest(documentId, [A, B, C]);
  const decisionId = await decisionIdOf(documentId);
  const v1 = await inlineDocument(decisionId);
  await ingest(documentId, [A, B2, C]);
  const v2 = await inlineDocument(decisionId);
  await ingest(documentId, [B3, C]);
  const v3 = await inlineDocument(decisionId);

  const redirects = await redirectsOf(decisionId);
  expect(redirects).toEqual(
    new Map([
      [anchorOf(v1, B), anchorOf(v3, B3)],
      [anchorOf(v2, B2), anchorOf(v3, B3)],
      [anchorOf(v1, A), null],
    ]),
  );
  const current = new Set(v3.blocks.map(({ anchorId }) => anchorId));
  for (const [from, to] of redirects) {
    expect(current.has(from)).toBe(false);
    expect(to === null || current.has(to)).toBe(true);
  }
});

test("a legacy row's positional anchors redirect to the stable anchor of the same words", async () => {
  const documentId = createSafeId<"caseLawDecision">();
  await ingest(documentId, [A, B, C]);
  const decisionId = await decisionIdOf(documentId);
  // A row written before stable anchors holds the parser's positional ones.
  const legacy = documentOf(documentId, [A, B, C]);
  await db
    .update(caseLawDecisions)
    .set({ documentAst: legacy })
    .where(eq(caseLawDecisions.id, decisionId));

  await ingest(documentId, [A, B, C]);
  const current = await inlineDocument(decisionId);
  const redirects = await redirectsOf(decisionId);

  expect([...redirects.keys()].toSorted()).toEqual(["p-1", "p-2", "p-3"]);
  for (const block of legacy.blocks) {
    const to = redirects.get(block.anchorId);
    expect(to).not.toBeNull();
    expect(textOf(current, to ?? "")).toBe(blockAnchorText(block));
  }
});

test("a canonical row's replaced document is read from object storage", async () => {
  const documentId = createSafeId<"caseLawDecision">();
  const reworded = `${B} Náklady řízení nebyly přiznány.`;
  await ingest(documentId, [A, B, C], packedCorpus);
  const decisionId = await decisionIdOf(documentId);
  const v1 = await packedDocument(decisionId);
  // The row keeps no inline copy, so the old anchors can only come from the pack.
  const inline = await db.execute(
    sql`SELECT document_ast IS NULL AS trimmed FROM case_law_decisions WHERE id = ${decisionId}::uuid`,
  );
  expect(inline.rows.at(0)).toEqual({ trimmed: true });

  await ingest(documentId, [A, reworded, C], packedCorpus);
  const v2 = await packedDocument(decisionId);

  expect(await redirectsOf(decisionId)).toEqual(
    new Map([[anchorOf(v1, B), anchorOf(v2, reworded)]]),
  );
});

test("the public read answers moved, gone and not redirected in asked order", async () => {
  const documentId = createSafeId<"caseLawDecision">();
  const reworded = `${B} Náklady řízení nebyly přiznány.`;
  await ingest(documentId, [A, B, C]);
  const decisionId = await decisionIdOf(documentId);
  const v1 = await inlineDocument(decisionId);
  await ingest(documentId, [reworded, C]);
  const v2 = await inlineDocument(decisionId);

  const answer = await db.transaction(
    async (tx) =>
      await readDecisionAnchorRedirects(asTestRaw(tx), {
        decisionId,
        anchors: [anchorOf(v1, B), anchorOf(v2, C), anchorOf(v1, A), "p-99"],
      }),
  );
  expect(answer).toEqual([
    {
      anchor: anchorOf(v1, B),
      redirect: {
        type: DECISION_ANCHOR_REDIRECT.MOVED,
        anchorId: anchorOf(v2, reworded),
      },
    },
    {
      anchor: anchorOf(v2, C),
      redirect: { type: DECISION_ANCHOR_REDIRECT.NOT_REDIRECTED },
    },
    {
      anchor: anchorOf(v1, A),
      redirect: { type: DECISION_ANCHOR_REDIRECT.GONE },
    },
    {
      anchor: "p-99",
      redirect: { type: DECISION_ANCHOR_REDIRECT.NOT_REDIRECTED },
    },
  ]);
});
