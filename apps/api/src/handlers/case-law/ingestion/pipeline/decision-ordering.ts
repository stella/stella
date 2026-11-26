import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import { createCaseLawDecisionSlug } from "@stll/api-contract/case-law-decision-route";

import type { ScopedDb } from "@/api/db/safe-db-types";
import {
  caseLawDecisionFallbackIdentities,
  caseLawDecisionSourceIdentities,
} from "@/api/db/schema";
import type { CaseLawIngestionBatchRecord } from "@/api/handlers/case-law/ingestion/pipeline/batch-types";
import { observeDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision-identity";
import type { SourceContract } from "@/api/handlers/case-law/ingestion/pipeline/source-contract";
import type { SafeId } from "@/api/lib/branded-types";
import { canonicalDecisionIdSql } from "@/api/lib/case-law/decision-alias";
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

const ecliKey = (ecli: string): string | undefined => {
  const key = fallbackEcliComparisonKey(ecli);
  return key === "" ? undefined : `ecli\u0000${key}`;
};

const storageKey = (key: string): string => `storage\u0000${key}`;

const decisionKey = (decisionId: string): string =>
  `decision\u0000${decisionId}`;

type OrderingContract = Pick<
  SourceContract,
  "metadataUrlSchema" | "heldDecisionAttachment"
>;

/**
 * The values identity resolution looks a stored decision up by, as a record
 * states them: its publisher identities, dockets, ECLI and fallback keys.
 */
type StoredDecisionLookup = {
  identities: readonly string[];
  dockets: readonly string[];
  eclis: readonly string[];
  fallbackIdentityKeys: readonly string[];
  fallbackContentHashes: readonly string[];
  fallbackPublicationHashes: readonly string[];
};

const NO_LOOKUP: StoredDecisionLookup = {
  identities: [],
  dockets: [],
  eclis: [],
  fallbackIdentityKeys: [],
  fallbackContentHashes: [],
  fallbackPublicationHashes: [],
};

type RecordOrdering = {
  keys: readonly string[];
  lookup: StoredDecisionLookup;
};

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
  ...[sourceDocumentId, sourceDocumentIdAliases, sourceDocumentIdRepairAliases]
    .flat()
    .flatMap((identity) =>
      identity === undefined ? [] : [identityKey(identity)],
    ),
];

const recordOrdering = (
  record: CaseLawIngestionBatchRecord,
  sourceId: SafeId<"caseLawSource">,
  { metadataUrlSchema, heldDecisionAttachment }: OrderingContract,
): RecordOrdering => {
  if (record.type === "rejected") {
    return { keys: [], lookup: NO_LOOKUP };
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
    // The write fails on the same observation before it reads or locks
    // anything, so no stored decision is in its reach.
    return { keys: stated, lookup: NO_LOOKUP };
  }
  const observation = observed.value;
  const { storageIdentity } = observation;
  const ecli =
    observation.observed.ecli === undefined
      ? undefined
      : ecliKey(observation.observed.ecli);
  const storage =
    storageIdentity.type === "unkeyable"
      ? []
      : decisionStorageLockKeys(storageIdentity);
  const fallbackDocket =
    storageIdentity.type === "strong" || storageIdentity.type === "content"
      ? [storageIdentity.identity.caseNumber]
      : [];
  const dockets = [
    observation.observed.caseNumber,
    ...observation.legacyCaseNumbers,
    ...fallbackDocket,
  ];
  return {
    keys: [
      ...new Set([
        ...stated,
        ...dockets.map(docketKey),
        ...observation.sourceIdentityCandidates.map(identityKey),
        ...(ecli === undefined ? [] : [ecli]),
        ...storage.map(storageKey),
      ]),
    ],
    lookup: {
      identities: observation.sourceIdentityCandidates,
      dockets,
      eclis:
        observation.observed.ecli === undefined
          ? []
          : [observation.observed.ecli],
      fallbackIdentityKeys:
        storageIdentity.type === "strong"
          ? storageIdentity.aliases.map(({ key }) => key)
          : [],
      fallbackContentHashes:
        storageIdentity.type === "content" ? [storageIdentity.contentHash] : [],
      fallbackPublicationHashes:
        storageIdentity.type === "strong" || storageIdentity.type === "content"
          ? [storageIdentity.publicationHash]
          : [],
    },
  };
};

/**
 * The keys under which two records of one batch could write the same rows,
 * as the records state them: the publisher identities the record's identity
 * locks take, its dockets (which carry its fallback identity, its
 * supplements' target and its slug), its ECLI and its fallback storage
 * locks. What is already stored joins them in {@link planDecisionOrdering}.
 *
 * A source rejection writes only its ledger row and has no keys.
 */
export const decisionOrderingKeys = (
  record: CaseLawIngestionBatchRecord,
  sourceId: SafeId<"caseLawSource">,
  contract: OrderingContract,
): readonly string[] => recordOrdering(record, sourceId, contract).keys;

/**
 * Rows a batch reads to tell which stored decisions its records reach. A
 * batch naming more than this many is not split: it is written serially.
 */
const STORED_ORDERING_ROW_LIMIT = 4096;

type StoredDecisionRow = {
  id: SafeId<"caseLawDecision">;
  sourceDocumentId: string | null;
  caseNumber: string;
  ecli: string | null;
  fallbackIdentityKey: string | null;
  fallbackContentHash: string | null;
  fallbackPublicationHash: string | null;
};

/**
 * The keys of one stored decision: its id, and every value of its own that
 * a record's keys name it by. A record that names one of them reaches it.
 */
const storedDecisionKeys = (row: StoredDecisionRow): string[] => {
  const ecli = row.ecli === null ? undefined : ecliKey(row.ecli);
  return [
    decisionKey(row.id),
    docketKey(row.caseNumber),
    ...(row.sourceDocumentId === null
      ? []
      : [identityKey(row.sourceDocumentId)]),
    ...(ecli === undefined ? [] : [ecli]),
    ...(row.fallbackIdentityKey === null
      ? []
      : [storageKey(row.fallbackIdentityKey)]),
    ...(row.fallbackContentHash === null
      ? []
      : [storageKey(`content:${row.fallbackContentHash}`)]),
    ...(row.fallbackPublicationHash === null
      ? []
      : [storageKey(`publication:${row.fallbackPublicationHash}`)]),
  ];
};

const distinct = (values: readonly (readonly string[])[]): string[] => [
  ...new Set(values.flat()),
];

/**
 * The stored decisions a batch's records can reach, each as the keys it is
 * reached by, read before any record is written. A superset of what
 * identity resolution can select: every stored decision of the source that
 * holds one of the records' publisher identities (in its row or the
 * identity registry, through its canonical id), dockets, ECLIs or fallback
 * keys. `null` when more rows match than the read takes.
 */
const readStoredDecisionKeys = async (
  scopedDb: ScopedDb,
  sourceId: SafeId<"caseLawSource">,
  lookups: readonly StoredDecisionLookup[],
): Promise<string[][] | null> => {
  const identities = distinct(lookups.map(({ identities: v }) => v));
  const dockets = distinct(lookups.map(({ dockets: v }) => v));
  const eclis = distinct(lookups.map(({ eclis: v }) => v));
  const fallbackIdentityKeys = distinct(
    lookups.map(({ fallbackIdentityKeys: v }) => v),
  );
  const fallbackContentHashes = distinct(
    lookups.map(({ fallbackContentHashes: v }) => v),
  );
  const fallbackPublicationHashes = distinct(
    lookups.map(({ fallbackPublicationHashes: v }) => v),
  );
  if (
    identities.length === 0 &&
    dockets.length === 0 &&
    eclis.length === 0 &&
    fallbackIdentityKeys.length === 0 &&
    fallbackContentHashes.length === 0 &&
    fallbackPublicationHashes.length === 0
  ) {
    return [];
  }
  return await scopedDb(async (tx) => {
    const claims =
      identities.length === 0
        ? []
        : await tx
            .select({
              decisionId: canonicalDecisionIdSql(
                caseLawDecisionSourceIdentities.decisionId,
              ),
              sourceDocumentId:
                caseLawDecisionSourceIdentities.sourceDocumentId,
            })
            .from(caseLawDecisionSourceIdentities)
            .where(
              and(
                eq(caseLawDecisionSourceIdentities.sourceId, sourceId),
                inArray(
                  caseLawDecisionSourceIdentities.sourceDocumentId,
                  identities,
                ),
              ),
            )
            .limit(STORED_ORDERING_ROW_LIMIT + 1);
    const fallbackClaims =
      fallbackIdentityKeys.length === 0
        ? []
        : await tx
            .select({
              decisionId: canonicalDecisionIdSql(
                caseLawDecisionFallbackIdentities.decisionId,
              ),
              identityKey: caseLawDecisionFallbackIdentities.identityKey,
            })
            .from(caseLawDecisionFallbackIdentities)
            .where(
              and(
                eq(caseLawDecisionFallbackIdentities.sourceId, sourceId),
                inArray(
                  caseLawDecisionFallbackIdentities.identityKey,
                  fallbackIdentityKeys,
                ),
              ),
            )
            .limit(STORED_ORDERING_ROW_LIMIT + 1);
    if (
      claims.length > STORED_ORDERING_ROW_LIMIT ||
      fallbackClaims.length > STORED_ORDERING_ROW_LIMIT
    ) {
      return null;
    }
    const claimedIds = [
      ...new Set([
        ...claims.map(({ decisionId }) => decisionId),
        ...fallbackClaims.map(({ decisionId }) => decisionId),
      ]),
    ];
    // Each arm reads one index; the fallback arms state the predicates of
    // their partial indexes, as the identity lookups they mirror do.
    const rows = await tx.query.caseLawDecisions.findMany({
      where: {
        sourceId: { eq: sourceId },
        OR: [
          ...(claimedIds.length === 0 ? [] : [{ id: { in: claimedIds } }]),
          ...(identities.length === 0
            ? []
            : [{ sourceDocumentId: { in: identities } }]),
          ...(dockets.length === 0 ? [] : [{ caseNumber: { in: dockets } }]),
          ...(eclis.length === 0
            ? []
            : [{ ecli: { isNotNull: true as const, in: eclis } }]),
          ...(fallbackIdentityKeys.length === 0
            ? []
            : [
                {
                  sourceDocumentId: { isNull: true as const },
                  fallbackIdentityKey: {
                    isNotNull: true as const,
                    in: fallbackIdentityKeys,
                  },
                },
              ]),
          ...(fallbackContentHashes.length === 0
            ? []
            : [
                {
                  sourceDocumentId: { isNull: true as const },
                  fallbackContentHash: {
                    isNotNull: true as const,
                    in: fallbackContentHashes,
                  },
                },
              ]),
          ...(fallbackPublicationHashes.length === 0
            ? []
            : [
                {
                  fallbackPublicationHash: {
                    isNotNull: true as const,
                    in: fallbackPublicationHashes,
                  },
                },
              ]),
        ],
      },
      columns: {
        id: true,
        sourceDocumentId: true,
        caseNumber: true,
        ecli: true,
        fallbackIdentityKey: true,
        fallbackContentHash: true,
        fallbackPublicationHash: true,
      },
      limit: STORED_ORDERING_ROW_LIMIT + 1,
    });
    if (rows.length > STORED_ORDERING_ROW_LIMIT) {
      return null;
    }
    return [
      ...claims.map(({ decisionId, sourceDocumentId }) => [
        decisionKey(decisionId),
        identityKey(sourceDocumentId),
      ]),
      ...fallbackClaims.map(({ decisionId, identityKey: key }) => [
        decisionKey(decisionId),
        storageKey(key),
      ]),
      ...rows.map(storedDecisionKeys),
    ];
  });
};

/**
 * One key per record: the component its keys fall into once every group
 * that shares a key is joined, transitively. `groups` are key sets known to
 * belong together (a stored decision and the values it is reached by).
 * Records without keys keep none.
 */
export const connectOrderingKeys = (
  recordKeys: readonly (readonly string[])[],
  groups: readonly (readonly string[])[] = [],
): string[][] => {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    let up = parent.get(root);
    while (up !== undefined && up !== root) {
      root = up;
      up = parent.get(root);
    }
    // Point the path straight at its root, so later finds are short.
    let at = key;
    while (at !== root) {
      const next = parent.get(at) ?? root;
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  const join = (keys: readonly string[]): void => {
    const [first, ...rest] = keys;
    if (first === undefined) {
      return;
    }
    if (!parent.has(first)) {
      parent.set(first, first);
    }
    for (const key of rest) {
      if (!parent.has(key)) {
        parent.set(key, key);
      }
      const left = find(first);
      const right = find(key);
      if (left !== right) {
        parent.set(right, left);
      }
    }
  };
  for (const keys of [...recordKeys, ...groups]) {
    join(keys);
  }
  return recordKeys.map((keys) => {
    const first = keys.at(0);
    return first === undefined ? [] : [`component\u0000${find(first)}`];
  });
};

type PlanDecisionOrderingOptions = {
  records: readonly CaseLawIngestionBatchRecord[];
  sourceId: SafeId<"caseLawSource">;
  contract: OrderingContract;
  scopedDb: ScopedDb;
};

/**
 * Each record's scheduling key, by batch position: records that could write
 * one row get one key and are written one after another, in batch order, as
 * a serial batch writes them; records of different keys commute.
 *
 * A record's own keys do not show every row it reaches: two records can name
 * one stored decision by different values (two registered aliases of it, or
 * an alias and its docket). So the stored decisions the batch can reach are
 * read first, and a record is joined to every stored decision any of its
 * values names, and through it to every other record that names one. The
 * join is transitive, so a record that reaches a row only through what an
 * earlier record of the batch writes (a newly reserved alias, a re-key) is
 * still ordered with every record that reaches that row.
 *
 * `null` when the read is too wide to split the batch on: it is then written
 * serially.
 */
export const planDecisionOrdering = async ({
  records,
  sourceId,
  contract,
  scopedDb,
}: PlanDecisionOrderingOptions): Promise<string[][] | null> => {
  const orderings = records.map((record) =>
    recordOrdering(record, sourceId, contract),
  );
  const stored = await readStoredDecisionKeys(
    scopedDb,
    sourceId,
    orderings.map(({ lookup }) => lookup),
  );
  return stored === null
    ? null
    : connectOrderingKeys(
        orderings.map(({ keys }) => keys),
        stored,
      );
};
