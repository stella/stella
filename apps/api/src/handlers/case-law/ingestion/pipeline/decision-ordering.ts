import { Result } from "better-result";

import { createCaseLawDecisionSlug } from "@stll/api-contract/case-law-decision-route";

import type { CaseLawIngestionBatchRecord } from "@/api/handlers/case-law/ingestion/pipeline/batch-types";
import { observeDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision-identity";
import type { SourceContract } from "@/api/handlers/case-law/ingestion/pipeline/source-contract";
import type { SafeId } from "@/api/lib/branded-types";
import {
  decisionStorageLockKeys,
  fallbackEcliComparisonKey,
} from "@/api/lib/case-law/fallback-decision-identity";

/**
 * What a docket is compared on here: its slug, which folds case, spacing and
 * punctuation. Coarser than any identity the write path keys a docket by, so
 * two records that could meet on a docket always share this key.
 */
const docketKey = (caseNumber: string): string =>
  `docket\u0000${createCaseLawDecisionSlug(caseNumber)}`;

const identityKey = (identity: string): string => `identity\u0000${identity}`;

/** Keys of a record whose observation does not form: its stated identities. */
const statedKeys = ({
  caseNumber,
  sourceDocumentId,
  sourceDocumentIdAliases,
  sourceDocumentIdRepairAliases,
  legacyCaseNumber,
}: Extract<CaseLawIngestionBatchRecord, { type: "decision" }>["decision"]) => [
  docketKey(caseNumber),
  ...(legacyCaseNumber === undefined ? [] : [docketKey(legacyCaseNumber)]),
  ...[
    sourceDocumentId,
    ...(sourceDocumentIdAliases ?? []),
    ...(sourceDocumentIdRepairAliases ?? []),
  ].flatMap((identity) =>
    identity === undefined ? [] : [identityKey(identity)],
  ),
];

/**
 * The keys under which two records of one batch could write the same rows:
 * the publisher identities the record's identity locks take, its dockets
 * (which carry its fallback identity, its supplements' target and its slug),
 * its ECLI and its fallback storage locks. Records that share no key touch
 * none of the same canonical rows, so their writes commute; records that
 * share one are written one after another, in batch order, as a serial
 * batch writes them.
 *
 * A source rejection writes only its ledger row and has no keys.
 */
export const decisionOrderingKeys = (
  record: CaseLawIngestionBatchRecord,
  sourceId: SafeId<"caseLawSource">,
  {
    metadataUrlSchema,
    heldDecisionAttachment,
  }: Pick<SourceContract, "metadataUrlSchema" | "heldDecisionAttachment">,
): readonly string[] => {
  if (record.type === "rejected") {
    return [];
  }
  const { decision } = record;
  const stated = statedKeys(decision);
  const observed = Result.try(() =>
    observeDecision({
      metadataUrlSchema,
      input: decision,
      sourceId,
      heldDecisionAttachment,
    }),
  ).andThen((observation) => observation);
  if (Result.isError(observed)) {
    // The write fails on the same observation before it locks anything.
    return stated;
  }
  const observation = observed.value;
  const ecli =
    observation.observed.ecli === undefined
      ? undefined
      : fallbackEcliComparisonKey(observation.observed.ecli);
  const storage =
    observation.storageIdentity.type === "unkeyable"
      ? []
      : decisionStorageLockKeys(observation.storageIdentity);
  return [
    ...new Set([
      ...stated,
      docketKey(observation.observed.caseNumber),
      ...observation.legacyCaseNumbers.map(docketKey),
      ...observation.sourceIdentityCandidates.map(identityKey),
      ...(ecli === undefined || ecli === "" ? [] : [`ecli\u0000${ecli}`]),
      ...storage.map((key) => `storage\u0000${key}`),
    ]),
  ];
};
