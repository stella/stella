import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
import { caseLawDecisions, caseLawSources, relations } from "@/api/db/schema";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { metadataMarkedListingOnly } from "@/api/lib/legal-search/partial-observation-sql";
import { LIMITS } from "@/api/lib/limits";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { serveForTest } from "@/api/tests/helpers/test-server";
import type { TestServer } from "@/api/tests/helpers/test-server";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

import { createVerifyQuotationHandler } from "./check";

const FULLTEXT = "Soud návrh zamítl pro opožděnost podání.";
const QUOTE = "Soud návrh zamítl";

const openSourceId = createSafeId<"caseLawSource">();
const closedSourceId = createSafeId<"caseLawSource">();
const openId = createSafeId<"caseLawDecision">();
const redactedId = createSafeId<"caseLawDecision">();
const listingOnlyId = createSafeId<"caseLawDecision">();
const closedId = createSafeId<"caseLawDecision">();
const unavailableCountryId = createSafeId<"caseLawDecision">();
const missingId = createSafeId<"caseLawDecision">();

let client: PGlite;
let server: TestServer;

// timeout: the schema push on an embedded Postgres outlasts the default budget.
beforeAll(
  async () => {
    client = await createTestPglite();
    const db = drizzle({
      client,
      relations: { ...relations, ...authRelationsPart },
    });
    const readDb = async <T>(
      fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    ) =>
      await withPublicLawReaderRole(
        db,
        async (roleTx) =>
          // SAFETY: the role transaction is the handle a public read receives;
          // the reads only use its select surface.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
          await fn(roleTx as unknown as CaseLawPublicReadTransaction),
      );
    await db.insert(caseLawSources).values([
      caseLawSourceRow({
        adapterKey: ADAPTER_KEYS.CZ_NS,
        id: openSourceId,
        name: "open",
      }),
      caseLawSourceRow({
        adapterKey: ADAPTER_KEYS.CZ_NSS,
        descriptor: {
          allowsDerivedAi: false,
          allowsRedistribution: false,
          attribution: null,
          license: "restricted",
        },
        id: closedSourceId,
        name: "closed",
      }),
    ]);
    const row = {
      country: "CZE",
      court: "Court",
      fulltext: FULLTEXT,
      language: "cs",
      sourceId: openSourceId,
    };
    await db.insert(caseLawDecisions).values([
      { ...row, caseNumber: "open", id: openId },
      {
        ...row,
        caseNumber: "redacted",
        // Erasure clears the text with the mark; without the gate this row
        // would answer `cannot_verify` and so confirm that it exists.
        fulltext: null,
        id: redactedId,
        redactedAt: new Date("2026-01-01"),
      },
      { ...row, caseNumber: "listing-only", id: listingOnlyId },
      {
        ...row,
        caseNumber: "closed",
        id: closedId,
        sourceId: closedSourceId,
      },
      {
        ...row,
        caseNumber: "unavailable-country",
        country: "XAA",
        id: unavailableCountryId,
        language: "xx",
      },
    ]);
    await db
      .update(caseLawDecisions)
      .set({ metadata: metadataMarkedListingOnly(caseLawDecisions.metadata) })
      .where(eq(caseLawDecisions.id, listingOnlyId));
    server = serveForTest(
      createHttpApp({
        routes: routes({
          "/case/decisions/quotes/verify": {
            POST: createVerifyQuotationHandler({
              // SAFETY: brand-only wrapper; the reads never inspect the marker.
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
              caseLawDb: readDb as unknown as CaseLawPublicReadDb,
              readSharedCorpus: () => false,
            }),
          },
        }),
        middleware: [errorBoundary],
      }),
    );
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await server.stop();
  await client.close();
});

const requestQuote = async (decisionId: string, text: string) => {
  const response = await server.fetch(
    new Request("http://localhost/case/decisions/quotes/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision_id: decisionId, text }),
    }),
  );
  const body: unknown = await response.json();
  return { status: response.status, body };
};

test("a public decision answers the quotation through the gated read", async () => {
  expect(await requestQuote(openId, QUOTE)).toMatchObject({
    status: 200,
    body: {
      status: "exact",
      verified: true,
      decisionId: openId,
      textSource: "fulltext",
    },
  });
});

test.each([
  ["missing", missingId],
  ["redacted", redactedId],
  ["listing-only", listingOnlyId],
  ["restricted by its source", closedId],
  ["outside the public countries", unavailableCountryId],
])("a decision that is %s answers one not-found", async (_name, decisionId) => {
  // A quote the stored text of a public row contains: only the gate refuses it.
  expect(await requestQuote(decisionId, QUOTE)).toEqual({
    status: 404,
    body: { message: "Decision not found" },
  });
});

test("a quote beyond the input bound is refused before any read", async () => {
  const { status } = await requestQuote(
    openId,
    "a".repeat(LIMITS.caseLawQuoteMaxChars + 1),
  );
  expect(status).toBeGreaterThanOrEqual(400);
  expect(status).toBeLessThan(500);
});
