import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { observedCensusCourt } from "@/api/lib/case-law/census-listing-identity";
import { readCompletenessCensusQuery } from "@/api/lib/case-law/completeness-census";
import { publisherCensusOf } from "@/api/lib/case-law/completeness-census-contract";
import { recordCompletenessCensus } from "@/api/lib/case-law/completeness-census-writer";
import {
  CENSUS_IDENTITY_BATCH_SIZE,
  readStoredListingIdentities,
} from "@/api/lib/case-law/stored-listing-identities";
import type { CensusListingIdentity } from "@/api/lib/legal-search/ingestion-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

test("court evidence distinguishes equal dockets and leaves unknown court observations unmeasured", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });
  const sourceId = createSafeId<"caseLawSource">();
  const leaseToken = createSafeId<"caseLawSourceIngestionLease">();
  const scope = { first: "2026", last: "2026", expectedSlices: 1 };
  const scopedDb: ScopedDb = async (read) =>
    await db.transaction(async (tx) => await read(asTestRaw<Transaction>(tx)));
  try {
    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: `census-court-${sourceId}`,
      name: "Court census fixture",
      ingestionLeaseToken: leaseToken,
      ingestionLeaseExpiresAt: new Date(Date.now() + 3_600_000),
    });
    await db.insert(caseLawDecisions).values({
      sourceId,
      sourceDocumentId: "held-at-a",
      caseNumber: "12 C 3/2026",
      court: "Okresní soud A",
      language: "cs",
      country: "CZE",
      fulltext: "Stored decision text",
    });
    expect(
      await rejectionOf(
        readStoredListingIdentities({
          tx: asTestRaw<Transaction>(db),
          sourceId,
          identities: Array.from(
            { length: CENSUS_IDENTITY_BATCH_SIZE + 1 },
            (_, index) => ({
              type: "document",
              sourceDocumentId: `oversized-${index}`,
            }),
          ),
        }),
      ),
    ).toMatchObject({
      _tag: "Panic",
      message: "Census identity batch exceeds its bound",
    });
    const identity = {
      type: "case-number",
      caseNumber: "12 C 3/2026",
      language: "cs",
    } as const;
    const read = async () =>
      await db.transaction(async (tx) =>
        (
          await readCompletenessCensusQuery(
            asTestRaw<CaseLawPublicReadTransaction>(tx),
            [{ id: sourceId, scope }],
          )
        ).get(String(sourceId)),
      );
    const record = async (
      identities: readonly CensusListingIdentity[],
      offset: number,
    ) => {
      await recordCompletenessCensus(scopedDb, {
        sourceId,
        leaseToken,
        adapterKey: "cz-regional",
        slice: "2026",
        scope,
        identities,
        publisherCount: undefined,
        observedAt: new Date(Date.UTC(2026, 9, 19, 12, 0, 0, offset)),
      });
    };
    await record(
      [
        {
          ...identity,
          censusCourtEvidence: observedCensusCourt("Okresní soud A"),
        },
        {
          ...identity,
          censusCourtEvidence: observedCensusCourt("Okresní soud B"),
        },
      ],
      0,
    );
    expect(await read()).toMatchObject({
      verdict: "incomplete",
      publisher: 2,
      stored: 1,
      withText: 1,
    });

    await record(
      [{ ...identity, censusCourtEvidence: { type: "unknown" } }],
      1,
    );
    const unknown = await read();
    expect(unknown).toMatchObject({
      verdict: "unmeasured",
      outcome: "identity-unproven",
      publisher: 1,
      stored: 0,
      shortSlices: 0,
    });
    expect(
      unknown === undefined ? undefined : publisherCensusOf(unknown).type,
    ).toBe("unknown");

    await record(
      [
        {
          ...identity,
          censusCourtEvidence: observedCensusCourt(" Okresní  soud A "),
        },
        {
          ...identity,
          censusCourtEvidence: observedCensusCourt("Okresní\u00a0soud A"),
        },
        {
          ...identity,
          censusCourtEvidence: observedCensusCourt("Okresni\u0301 soud A"),
        },
      ],
      2,
    );
    expect(await read()).toMatchObject({
      verdict: "complete",
      publisher: 1,
      stored: 1,
    });
  } finally {
    await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
    await client.close();
  }
});
