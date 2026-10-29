import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { chunk } from "@stll/concurrency/chunk";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawCompletenessCensus as census } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { censusScope } from "@/api/lib/case-law/completeness-census";
import { censusCapabilityFor } from "@/api/lib/case-law/completeness-census-capabilities";
import { measureCensusCounts } from "@/api/lib/case-law/completeness-census-contract";
import { readStoredListingIdentities } from "@/api/lib/case-law/stored-listing-identities";
import { lockCaseLawSourceIngestionLease } from "@/api/lib/db/aggregate-lock";
import type { ListingIdentity } from "@/api/lib/legal-search/ingestion-types";
import { listingIdentityKey } from "@/api/lib/legal-search/ingestion-types";
import {
  createUnrecognizedSourceReporter,
  SOURCE_REPORT_FEATURE,
} from "@/api/lib/legal-search/source-registry-membership";

const CENSUS_IDENTITY_BATCH_SIZE = 500;

type CensusIdentityMatch = {
  identity: ListingIdentity;
  decisions: Awaited<
    ReturnType<typeof readStoredListingIdentities>
  >[number]["decisions"];
};

/**
 * A stored decision answers for one listed entry. Document entries claim theirs
 * across the whole listing first, so a case-number entry in another batch can
 * never count a row the listing already names by document id.
 */
const countCensusMatches = (matches: readonly CensusIdentityMatch[]) => {
  const claimed = new Set(
    matches.flatMap(({ identity, decisions }) =>
      identity.type === "document" ? decisions.map(({ id }) => id) : [],
    ),
  );
  let storedCount = 0;
  let textCount = 0;
  for (const { identity, decisions } of matches) {
    const counted = countedDecisions({ identity, decisions, claimed });
    if (counted.length === 0) {
      continue;
    }
    storedCount += 1;
    if (counted.some(({ withText }) => withText)) {
      textCount += 1;
    }
  }
  return { storedCount, textCount };
};

const countedDecisions = ({
  identity,
  decisions,
  claimed,
}: CensusIdentityMatch & { claimed: ReadonlySet<string> }) => {
  switch (identity.type) {
    case "document":
      return decisions;
    case "case-number":
      return decisions.filter(({ id }) => !claimed.has(id));
    case "unidentifiable":
      return panic("Census lookup matched an unkeyable listing entry");
    default:
      identity satisfies never;
      return panic("Unhandled listing identity type");
  }
};

type RecordCensusOptions = {
  sourceId: SafeId<"caseLawSource">;
  leaseToken: SafeId<"caseLawSourceIngestionLease">;
  adapterKey: string;
  slice: string;
  scope: ReturnType<typeof censusScope>;
  identities: readonly ListingIdentity[];
  /** Includes unkeyable entries: they must never vanish from the denominator. */
  listed: number;
  publisherCount: number | undefined;
  observedAt: Date;
};

/** The source lock fences stale workers; counts and observation commit together. */
export const recordCompletenessCensus = async (
  scopedDb: ScopedDb,
  options: RecordCensusOptions,
) => {
  const capability = censusCapabilityFor(options.adapterKey);
  if (capability === undefined) {
    createUnrecognizedSourceReporter(SOURCE_REPORT_FEATURE.completenessCensus)(
      options.adapterKey,
    );
    return;
  }
  const year = /^\d{4}/u.exec(options.slice)?.at(0);
  if (capability.type !== "none-exposed" && year === undefined) {
    panic(`Census slice lacks a year: ${options.adapterKey}/${options.slice}`);
  }
  const measured = measureCensusCounts(options);
  const outcome =
    capability.type === "none-exposed" ? capability.type : measured.outcome;
  // A stated total cannot erase identities already enumerated by the publisher.
  const publisherCount =
    outcome === "none-exposed" ? null : measured.publisherCount;
  await scopedDb(async (tx) => {
    if (
      !(await lockCaseLawSourceIngestionLease({
        tx,
        sourceId: options.sourceId,
        leaseToken: options.leaseToken,
      }))
    ) {
      return;
    }
    const identitiesByKey = new Map<string, ListingIdentity>();
    for (const identity of options.identities) {
      const key = listingIdentityKey(identity);
      if (key !== null) {
        identitiesByKey.set(key, identity);
      }
    }
    const matches: CensusIdentityMatch[] = [];
    for (const batch of chunk(
      [...identitiesByKey.values()],
      CENSUS_IDENTITY_BATCH_SIZE,
    )) {
      const rows = await readStoredListingIdentities({
        tx,
        sourceId: options.sourceId,
        identities: batch,
      });
      for (const { key, decisions } of rows) {
        matches.push({
          identity:
            identitiesByKey.get(key) ??
            panic(`Census lookup returned an unlisted identity: ${key}`),
          decisions,
        });
      }
    }
    const { storedCount, textCount } = countCensusMatches(matches);
    const observation = {
      sourceId: options.sourceId,
      slice: options.slice,
      year: year === undefined || Number(year) === 0 ? null : Number(year),
      outcome,
      scopeExtent:
        capability.type === "none-exposed"
          ? "partial-publisher"
          : capability.scopeStatus,
      publisherCount,
      publisherStatedCount: measured.publisherStatedCount,
      enumeratedCount: measured.enumeratedCount,
      storedCount,
      textCount,
      observedAt: options.observedAt,
      scopeFirst: options.scope.first,
      scopeLast: options.scope.last,
      expectedSlices: options.scope.expectedSlices,
      evidenceRef: capability.evidenceRef,
    } as const satisfies typeof census.$inferInsert;
    // audit: skip — public-corpus sweep observation under the source ingestion lease
    await tx
      .insert(census)
      .values(observation)
      .onConflictDoUpdate({
        target: [census.sourceId, census.slice],
        set: observation,
        setWhere: sql`${census.observedAt} <= ${options.observedAt.toISOString()}::timestamptz`,
      });
  });
};
