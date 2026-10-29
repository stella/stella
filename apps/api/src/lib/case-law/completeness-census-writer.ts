import { panic, Result } from "better-result";
import { sql } from "drizzle-orm";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { chunk } from "@stll/concurrency/chunk";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawCompletenessCensus as census } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { censusListingEvidenceKey } from "@/api/lib/case-law/census-listing-identity";
import type { censusScope } from "@/api/lib/case-law/completeness-census";
import { censusCapabilityFor } from "@/api/lib/case-law/completeness-census-capabilities";
import {
  measureCensusCounts,
  type SourceCensus,
} from "@/api/lib/case-law/completeness-census-contract";
import {
  CENSUS_IDENTITY_BATCH_SIZE,
  readStoredListingIdentities,
} from "@/api/lib/case-law/stored-listing-identities";
import { lockCaseLawSourceIngestionLease } from "@/api/lib/db/aggregate-lock";
import type { CensusListingIdentity } from "@/api/lib/legal-search/ingestion-types";
import {
  createUnrecognizedSourceReporter,
  SOURCE_REPORT_FEATURE,
} from "@/api/lib/legal-search/source-registry-membership";

type CensusIdentityMatch = Awaited<
  ReturnType<typeof readStoredListingIdentities>
>[number];

/**
 * A stored decision answers for one listed entry. Document entries claim theirs
 * across the whole listing first, so a case-number entry in another batch can
 * never count a row the listing already names by document id.
 */
const countCensusMatches = (matches: readonly CensusIdentityMatch[]) => {
  const claimed = new Set(
    matches.flatMap(({ kind, decisions }) =>
      kind === "document" ? decisions.map(({ id }) => id) : [],
    ),
  );
  let storedCount = 0;
  let textCount = 0;
  for (const { kind, decisions } of matches) {
    const counted = countedDecisions({ kind, decisions, claimed });
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
  kind,
  decisions,
  claimed,
}: Pick<CensusIdentityMatch, "kind" | "decisions"> & {
  claimed: ReadonlySet<string>;
}) => {
  switch (kind) {
    case "document":
      return decisions;
    case "case-number":
      return decisions.filter(({ id }) => !claimed.has(id));
    default:
      kind satisfies never;
      return panic("Unhandled listing identity type");
  }
};

type RecordCensusOptions = {
  sourceId: SafeId<"caseLawSource">;
  leaseToken: SafeId<"caseLawSourceIngestionLease">;
  adapterKey: string;
  slice: string;
  scope: ReturnType<typeof censusScope>;
  identities: readonly CensusListingIdentity[];
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
  const yearToken = /^\d{4}/u.exec(options.slice)?.at(0);
  if (capability.type !== "none-exposed" && yearToken === undefined) {
    panic(`Census slice lacks a year: ${options.adapterKey}/${options.slice}`);
  }
  const year = parseIntegerToken(yearToken ?? "0", { min: 0, max: 9999 });
  if (Result.isError(year)) {
    panic(`Census slice has an invalid year: ${options.slice}`);
  }
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
    const identitiesByKey = new Map<string, CensusListingIdentity>();
    let unidentifiable = 0;
    for (const identity of options.identities) {
      const key = censusListingEvidenceKey(identity);
      if (key === null) {
        unidentifiable += 1;
      } else {
        identitiesByKey.set(key, identity);
      }
    }
    const canonical = new Map<string, CensusIdentityMatch>();
    for (const batch of chunk(
      [...identitiesByKey.values()],
      CENSUS_IDENTITY_BATCH_SIZE,
    )) {
      const rows = await readStoredListingIdentities({
        tx,
        sourceId: options.sourceId,
        identities: batch,
      });
      for (const row of rows) {
        const previous = canonical.get(row.key);
        if (previous === undefined) {
          canonical.set(row.key, row);
        } else {
          previous.decisions.push(...row.decisions);
        }
      }
    }
    const matches = [...canonical.values()];
    const measured = measureCensusCounts({
      listed: matches.length + unidentifiable,
      publisherCount: options.publisherCount,
    });
    let outcome: SourceCensus["outcome"] = measured.outcome;
    if (capability.type === "none-exposed") {
      outcome = capability.type;
    } else if (matches.some(({ evidence }) => evidence === "unmeasured")) {
      outcome = "identity-unproven";
    }
    const publisherCount =
      outcome === "none-exposed" ? null : measured.publisherCount;
    const { storedCount, textCount } = countCensusMatches(matches);
    const observation = {
      sourceId: options.sourceId,
      slice: options.slice,
      year: year.value === 0 ? null : year.value,
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
    // audit: skip - Public corpus observation under the ingestion lease; no tenant actor.
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
