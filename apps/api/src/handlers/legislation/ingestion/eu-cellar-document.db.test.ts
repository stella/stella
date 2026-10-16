import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";

import { LEGISLATION_IDENTITY_MODES } from "@stll/api-contract/legislation-expression";
import { sha256Hex } from "@stll/sha256/node";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  legislationDocuments,
  legislationSources,
  legislationWorkIdentifiers,
} from "@/api/db/schema";
import { resolveStatuteWorkVersion } from "@/api/handlers/legislation/by-eli";
import { processLegislationDocument } from "@/api/handlers/legislation/ingestion";
import type { LegislationCorpusDependencies } from "@/api/handlers/legislation/ingestion";
import {
  parseEuCellarDocument,
  reparseEuCellarDocument,
} from "@/api/handlers/legislation/ingestion/eu-cellar-document";
import { stripDangerousChars } from "@/api/lib/legal-search/corpus-sanitize";
import type { WriteRawSourcePayload } from "@/api/lib/legal-search/raw-source-storage";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const WORK =
  "http://publications.europa.eu/resource/cellar/55862dbf-c72b-11eb-a925-01aa75ed71a1";
const EXPRESSION = `${WORK}.0006`;
const MANIFESTATION = `${EXPRESSION}.03`;
const ITEM = `${MANIFESTATION}/DOC_1`;
const CELEX = "32021D0914";
const NOTICE = readFileSync(
  new URL("__fixtures__/eu-branch-notice.xml", import.meta.url),
  "utf-8",
);
const CONTENT = readFileSync(
  new URL("__fixtures__/eu-annex.xhtml", import.meta.url),
  "utf-8",
);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;
let legislationDb: LegislationReadDb;

const corpus = {
  mode: "off",
  write: async () =>
    panic("corpus writes are disabled for this ingestion test"),
} satisfies LegislationCorpusDependencies;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  scopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));
  legislationDb = async (callback) => await callback(asTestRaw(db));
});

afterAll(async () => {
  await client.close();
});

test("a CELLAR notice and annex persist as one replayable unpublished publisher expression", async () => {
  const [source] = await db
    .insert(legislationSources)
    .values({
      adapterKey: "eu-cellar-document-test",
      name: "CELLAR document test",
      expressionNamespace: "cellar",
      identityMode: LEGISLATION_IDENTITY_MODES.publisher,
      descriptor: {
        license: "restricted",
        attribution: null,
        allowsRedistribution: false,
        allowsDerivedAi: false,
      },
    })
    .returning({ id: legislationSources.id });
  if (source === undefined) {
    panic("CELLAR test source was not inserted");
  }
  const normalized = parseEuCellarDocument({
    sourceId: source.id,
    noticeXml: NOTICE,
    manifestationIri: MANIFESTATION,
    itemIri: ITEM,
    content: { type: "xhtml", html: CONTENT },
    origin: "live",
  });
  if (normalized.isErr()) {
    panic(normalized.error.message);
  }
  if (normalized.value.type !== "document") {
    panic("fixture is not a legislation document");
  }
  const calls: Parameters<WriteRawSourcePayload>[0][] = [];
  const writeSourceRaw: WriteRawSourcePayload = async (options) => {
    calls.push(options);
    return `${options.owner.family}/raw/${options.owner.sourceId}/${sha256Hex(options.data)}`;
  };
  const stored = await processLegislationDocument(
    normalized.value.document,
    scopedDb,
    { corpus, writeSourceRaw },
  );
  if (stored.type !== "stored") {
    panic(`expected stored legislation, got ${stored.type}`);
  }
  expect(stored).toMatchObject({ inserted: true, skipped: false });
  const [row] = await db
    .select()
    .from(legislationDocuments)
    .where(eq(legislationDocuments.id, stored.id));
  if (row === undefined) {
    panic("normalized CELLAR expression was not stored");
  }
  expect(row).toMatchObject({
    eli: WORK,
    country: "EU",
    language: "en",
    publisherExpressionId: `cellar:${EXPRESSION}`,
    identityMode: LEGISLATION_IDENTITY_MODES.publisher,
    expressionKind: "promulgated",
    documentType: "decision",
    status: "unknown",
    versionValidFrom: null,
    versionValidTo: null,
    windowDisposition: "invalid-window",
    windowDispositionBasis: "missing-start",
    sourceRawContentType: "application/json",
  });
  expect(row.fulltext).toContain("STANDARD CONTRACTUAL CLAUSES");
  expect(row.fulltext).toContain("Purpose and scope");
  expect(row.documentAst).toEqual(normalized.value.document.ast);
  expect(row.metadata?.["publisherEvidence"]).toEqual(
    expect.objectContaining({
      dates: expect.arrayContaining([
        expect.objectContaining({
          meaning: { type: "entry-into-force" },
          lexicalValue: "2021-06-27",
          normalizedDate: "2021-06-27",
        }),
        expect.objectContaining({
          meaning: { type: "end-of-validity" },
          lexicalValue: "9999-12-31",
          normalizedDate: null,
        }),
      ]),
    }),
  );
  const aliases = await db
    .select({
      identifier: legislationWorkIdentifiers.identifier,
      eli: legislationWorkIdentifiers.eli,
    })
    .from(legislationWorkIdentifiers)
    .where(eq(legislationWorkIdentifiers.sourceId, source.id));
  expect(aliases).toEqual(
    expect.arrayContaining([
      { identifier: WORK, eli: WORK },
      { identifier: CELEX, eli: WORK },
    ]),
  );
  expect(calls).toHaveLength(1);
  const raw = calls.at(0);
  if (raw === undefined) {
    panic("raw publisher snapshot was not recorded");
  }
  if (typeof raw.data !== "string") {
    panic("CELLAR raw snapshot must be recorded as JSON text");
  }
  expect(raw.owner).toEqual({ family: "legislation", sourceId: source.id });
  expect(raw.contentType).toBe("application/json");
  expect(raw.data).toBe(
    stripDangerousChars(normalized.value.document.sourceRaw),
  );
  const snapshot: unknown = JSON.parse(raw.data);
  expect(snapshot).toMatchObject({
    schema: "eu-cellar-document-v1",
    noticeXml: stripDangerousChars(NOTICE),
    manifestationIri: MANIFESTATION,
    itemIri: ITEM,
    content: { type: "xhtml", html: stripDangerousChars(CONTENT) },
  });
  expect(row.sourceRawS3Key).toBe(
    `legislation/raw/${source.id}/${sha256Hex(raw.data)}`,
  );

  const reparsed = reparseEuCellarDocument({
    sourceId: source.id,
    raw: raw.data,
  });
  if (reparsed.isErr()) {
    panic(reparsed.error.message);
  }
  if (reparsed.value.type !== "document") {
    panic("stored snapshot is not a legislation document");
  }
  expect(reparsed.value.document.origin).toBe("stored-raw-replay");
  expect(reparsed.value.document.rawHash).toBe(
    normalized.value.document.rawHash,
  );
  const replay = await processLegislationDocument(
    reparsed.value.document,
    scopedDb,
    { corpus, writeSourceRaw },
  );
  expect(replay).toMatchObject({
    type: "stored",
    id: stored.id,
    inserted: false,
    skipped: true,
  });
  expect(calls).toHaveLength(1);
  expect(
    await db
      .select({ id: legislationDocuments.id })
      .from(legislationDocuments)
      .where(eq(legislationDocuments.sourceId, source.id)),
  ).toEqual([{ id: stored.id }]);
  for (const surface of ["pages", "search"] as const) {
    expect(
      await resolveStatuteWorkVersion({ eli: CELEX }, legislationDb, surface),
    ).toEqual({ type: "unknown-work" });
  }
  await db
    .update(legislationSources)
    .set({ descriptor: null })
    .where(eq(legislationSources.id, source.id));
  for (const surface of ["pages", "search"] as const) {
    expect(
      await resolveStatuteWorkVersion({ eli: CELEX }, legislationDb, surface),
    ).toEqual({ type: "unknown-work" });
  }
});
