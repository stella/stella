/**
 * The contract one physical index group of a generation is created, written
 * and read under: the generation's manifest, or a group contract derived from
 * it.
 *
 * A manifest is immutable and its digest is every existing group's identity,
 * so a group that needs a different mapping cannot say so inside it. A group
 * contract says it beside it instead: an immutable artifact binding the base
 * manifest's digest to the group's effective configuration and to what its
 * projection adds, hashed on its own. Groups under `base` resolve to the
 * manifest unchanged, with no digest of their own, and keep the attestation
 * their generation already has.
 *
 * Which contract a group is under is declared in
 * `CASE_LAW_INDEX_GROUP_CONTRACT_OF`, never inferred from an index name.
 * Configuration, projection and query capabilities all resolve through this
 * module, so an index created under a contract is written and read under the
 * same one.
 */

import { panic } from "better-result";

import {
  resolveUsCourt,
  US_COURT_BY_CANONICAL_NAME,
  US_COURT_PARTITION_COUNT,
  US_COURT_PARTITION_KEY_PREFIX,
  US_COURT_PARTITIONS,
  type UsCourtPartition,
} from "@stll/api-contract/us-courts";

import {
  CASE_LAW_INDEX_GROUP_CONTRACT_OF,
  CASE_LAW_INDEX_GROUP_NAMES,
  CASE_LAW_INDEX_GROUPS,
  caseLawIndexGroup,
  isCaseLawIndexGroup,
  type CaseLawIndexGroup,
  type CorpusIndexGroupContractVersion,
} from "@/api/lib/legal-search/case-law-index-groups";
import type { CorpusIndexConfig } from "@/api/lib/legal-search/corpus-index-config";
import {
  corpusIndexConfigWithId,
  corpusIndexContractDigest,
  corpusIndexIdFromManifest,
  corpusIndexManifestDigest,
  corpusIndexRoute,
  type CorpusIndexManifest,
  type CorpusIndexRoute,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { CORPUS_READ_TARGET_IDENTITY_LENGTH } from "@/api/lib/legal-search/corpus-search-cursor";
import { deepFreeze } from "@/api/lib/legal-search/deep-freeze";

/** The index field a court-partitioned group routes its splits by. */
export const COURT_PARTITION_FIELD = "court_partition";

/** The field whose tag the partition replaces; it stays indexed and fast. */
const COURT_FIELD = "court";

/**
 * What a `court_partition_v1` projection writes beyond the base projection:
 * the court's partition on every passage, derived from the stored court id.
 */
const COURT_PARTITION_PROJECTION_EXTENSION = "court-partition-every-passage-v1";

type UnindexedConfig = Omit<CorpusIndexConfig, "index_id">;
type FieldMapping = CorpusIndexConfig["doc_mapping"]["field_mappings"][number];

/**
 * The immutable artifact a `court_partition_v1` group is bound to. Its digest
 * is the group's effective-contract digest: what an enrollment records, what
 * a projection fingerprint and a cursor carry, and what an operator attests a
 * physical index against.
 */
export type CourtPartitionContractArtifact = {
  contract: "court_partition_v1";
  family: "case_law";
  generation: string;
  indexGroup: string;
  baseManifestDigest: string;
  indexConfig: UnindexedConfig;
  partition: {
    field: typeof COURT_PARTITION_FIELD;
    courtDirectory: "USA";
    keyPrefix: typeof US_COURT_PARTITION_KEY_PREFIX;
    hash: "sha256-first-byte-mod";
    count: typeof US_COURT_PARTITION_COUNT;
    values: readonly UsCourtPartition[];
  };
  projectionExtension: typeof COURT_PARTITION_PROJECTION_EXTENSION;
};

type GroupContractCommon = {
  manifest: CorpusIndexManifest;
  indexGroup: string;
  indexId: string;
  /** The configuration the group's physical index is created with. */
  indexConfig: UnindexedConfig;
};

export type BaseGroupContract = GroupContractCommon & { type: "base" };

export type CourtPartitionGroupContract = GroupContractCommon & {
  type: "court_partition_v1";
  artifact: CourtPartitionContractArtifact;
  effectiveDigest: string;
};

export type CorpusIndexGroupContract =
  | BaseGroupContract
  | CourtPartitionGroupContract;

/** A group contract other than the manifest's own. */
export type EnrolledGroupContract = Exclude<
  CorpusIndexGroupContract,
  BaseGroupContract
>;

const courtPartitionField = (): FieldMapping => ({
  name: COURT_PARTITION_FIELD,
  type: "text",
  tokenizer: "raw",
  indexed: true,
  stored: false,
  fast: false,
  record: "basic",
  fieldnorms: false,
});

/**
 * The base configuration with `court` taken out of the tag fields and the
 * partition field mapped, tagged and set as the partition key. `court` keeps
 * its mapping exactly: indexed and raw for the exact filter, fast for facets.
 * Everything else, other tags and the default search fields included, is the
 * base's.
 */
const courtPartitionIndexConfig = (base: UnindexedConfig): UnindexedConfig => {
  const mapping = base.doc_mapping;
  const court =
    mapping.field_mappings.find(({ name }) => name === COURT_FIELD) ??
    panic("Court partition contract needs a mapped court field");
  if (court.tokenizer !== "raw" || !court.indexed || !court.fast) {
    return panic("Court partition contract needs a raw, indexed, fast court");
  }
  if (
    mapping.field_mappings.some(({ name }) => name === COURT_PARTITION_FIELD)
  ) {
    return panic("Base configuration already maps the court partition field");
  }
  // The engine coalesces partitions past this bound, which would silently
  // mix buckets back together.
  if ((mapping.max_num_partitions ?? 0) <= US_COURT_PARTITION_COUNT) {
    return panic("Court partition count exceeds the engine partition bound");
  }
  const config = structuredClone(base);
  return {
    ...config,
    doc_mapping: {
      ...config.doc_mapping,
      field_mappings: [
        ...config.doc_mapping.field_mappings,
        courtPartitionField(),
      ],
      tag_fields: [
        ...config.doc_mapping.tag_fields.filter(
          (field) => field !== COURT_FIELD,
        ),
        COURT_PARTITION_FIELD,
      ],
      partition_key: COURT_PARTITION_FIELD,
    },
  };
};

const groupIndexId = (
  manifest: CorpusIndexManifest,
  indexGroup: string,
): string => {
  switch (manifest.family) {
    case "case_law": {
      if (!isCaseLawIndexGroup(indexGroup)) {
        return panic(`Undeclared case-law index group: ${indexGroup}`);
      }
      const member =
        CASE_LAW_INDEX_GROUPS.get(indexGroup)?.at(0) ??
        panic(`Index group without members: ${indexGroup}`);
      return corpusIndexIdFromManifest(manifest, member);
    }
    case "legislation":
      return corpusIndexIdFromManifest(manifest, indexGroup);
    default:
      manifest satisfies never;
      return panic(`Unhandled manifest: ${String(manifest)}`);
  }
};

const courtPartitionContract = (
  manifest: Extract<CorpusIndexManifest, { family: "case_law" }>,
  indexGroup: CaseLawIndexGroup,
  indexId: string,
): CourtPartitionGroupContract => {
  const indexConfig = courtPartitionIndexConfig(manifest.engine.indexConfig);
  const artifact: CourtPartitionContractArtifact = {
    contract: "court_partition_v1",
    family: manifest.family,
    generation: manifest.generation,
    indexGroup,
    baseManifestDigest: corpusIndexManifestDigest(manifest),
    indexConfig,
    partition: {
      field: COURT_PARTITION_FIELD,
      courtDirectory: "USA",
      keyPrefix: US_COURT_PARTITION_KEY_PREFIX,
      hash: "sha256-first-byte-mod",
      count: US_COURT_PARTITION_COUNT,
      values: [...US_COURT_PARTITIONS],
    },
    projectionExtension: COURT_PARTITION_PROJECTION_EXTENSION,
  };
  return {
    type: "court_partition_v1",
    manifest,
    indexGroup,
    indexId,
    indexConfig,
    artifact,
    effectiveDigest: corpusIndexContractDigest(artifact),
  };
};

const resolveUncached = (
  manifest: CorpusIndexManifest,
  indexGroup: string,
): CorpusIndexGroupContract => {
  const indexId = groupIndexId(manifest, indexGroup);
  const base: BaseGroupContract = {
    type: "base",
    manifest,
    indexGroup,
    indexId,
    indexConfig: manifest.engine.indexConfig,
  };
  if (manifest.family !== "case_law" || !isCaseLawIndexGroup(indexGroup)) {
    return base;
  }
  const version = CASE_LAW_INDEX_GROUP_CONTRACT_OF[indexGroup];
  switch (version) {
    case "base":
      return base;
    case "court_partition_v1":
      return courtPartitionContract(manifest, indexGroup, indexId);
    default:
      version satisfies never;
      return panic(`Unhandled group contract: ${String(version)}`);
  }
};

const contractCache = new WeakMap<
  CorpusIndexManifest,
  Map<string, CorpusIndexGroupContract>
>();

/** The contract `indexGroup` of `manifest`'s generation is under. */
export const resolveCorpusIndexGroupContract = ({
  manifest,
  indexGroup,
}: {
  manifest: CorpusIndexManifest;
  indexGroup: string;
}): CorpusIndexGroupContract => {
  const byGroup =
    contractCache.get(manifest) ?? new Map<string, CorpusIndexGroupContract>();
  contractCache.set(manifest, byGroup);
  const cached = byGroup.get(indexGroup);
  if (cached !== undefined) {
    return cached;
  }
  const contract = deepFreeze(resolveUncached(manifest, indexGroup));
  byGroup.set(indexGroup, contract);
  return contract;
};

/** The contract of the group a jurisdiction's documents are written to. */
export const corpusIndexGroupContractForJurisdiction = (
  manifest: CorpusIndexManifest,
  jurisdiction: string,
): CorpusIndexGroupContract =>
  resolveCorpusIndexGroupContract({
    manifest,
    indexGroup:
      manifest.family === "case_law"
        ? caseLawIndexGroup(jurisdiction)
        : jurisdiction.toLowerCase(),
  });

/**
 * The groups of `manifest` under a contract of their own, each of which must
 * be enrolled and attested before it is read or written.
 */
export const enrolledCorpusIndexGroupContracts = (
  manifest: CorpusIndexManifest,
): EnrolledGroupContract[] => {
  if (manifest.family !== "case_law") {
    return [];
  }
  return [...CASE_LAW_INDEX_GROUPS.keys()].flatMap((indexGroup) => {
    const contract = resolveCorpusIndexGroupContract({ manifest, indexGroup });
    return contract.type === "base" ? [] : [contract];
  });
};

/**
 * What a continuation cursor must agree with the read about. A scoped read of
 * a group under its manifest's contract binds nothing, so its cursor keeps the
 * form it always had. Any other read binds the exact indexes it reaches and
 * the effective digest of every enrolled one: a group joining or leaving a
 * generation-wide read, or a replacement contract, changes the identity.
 */
const readTargetIdentity = (
  manifest: CorpusIndexManifest,
  reached: readonly ReachedIndex[],
): string =>
  corpusIndexContractDigest({
    generation: manifest.generation,
    indexes: reached.map(({ contract, name, reach }) => ({
      name,
      reach,
      ...(contract.type === "base"
        ? {}
        : { effectiveDigest: contract.effectiveDigest }),
    })),
  }).slice(0, CORPUS_READ_TARGET_IDENTITY_LENGTH);

/**
 * How a read names one group's index: `exact` by its id, or `bridged` by the
 * pattern over its id (`corpusIndexReadTarget`).
 */
type ReachedIndex = {
  contract: CorpusIndexGroupContract;
  name: string;
  reach: "exact" | "bridged";
};

export type CorpusIndexReadTarget = {
  route: CorpusIndexRoute;
  /** The contract of the one index a scoped read reaches; null when global. */
  contract: CorpusIndexGroupContract | null;
  /** What a continuation cursor binds (`readTargetIdentity`). */
  cursorTarget: string | null;
};

export type CorpusIndexReadTargetResolution =
  | { type: "ready"; target: CorpusIndexReadTarget }
  | { type: "unready"; contract: EnrolledGroupContract };

/**
 * The groups under their manifest's contract a generation was created with.
 * The manifest records them (`route.byJurisdiction`), and their indexes exist
 * for as long as the generation is active.
 */
export const createdCaseLawBaseGroups = (
  manifest: Extract<CorpusIndexManifest, { family: "case_law" }>,
): ReadonlySet<string> =>
  new Set(
    Object.values(manifest.route.byJurisdiction).filter(
      (indexGroup) =>
        resolveCorpusIndexGroupContract({ manifest, indexGroup }).type ===
        "base",
    ),
  );

/**
 * A group the registry records an index for, with the digest its index is
 * attested against. Two kinds: a group under a contract of its own
 * (`enrolledCorpusIndexGroupContracts`), attested against its effective
 * digest before anything reads or writes it; and a group under its manifest's
 * contract declared after the generation was created, which the manifest
 * cannot say has an index, attested against the manifest digest once it does.
 * The second kind is recorded only for generation-wide reads to reach it; its
 * scoped reads and its writes never wait on the registry, as before.
 */
export type RegisteredCorpusIndexGroup = {
  manifest: CorpusIndexManifest;
  indexGroup: string;
  indexId: string;
  contractVersion: "base" | CorpusIndexGroupContractVersion;
  effectiveDigest: string;
};

const registeredGroupOf = (
  contract: CorpusIndexGroupContract,
): RegisteredCorpusIndexGroup => ({
  manifest: contract.manifest,
  indexGroup: contract.indexGroup,
  indexId: contract.indexId,
  contractVersion: contract.type,
  effectiveDigest:
    contract.type === "base"
      ? corpusIndexManifestDigest(contract.manifest)
      : contract.effectiveDigest,
});

/** Every group of `manifest` the registry may record. */
export const registeredCorpusIndexGroups = (
  manifest: CorpusIndexManifest,
): RegisteredCorpusIndexGroup[] => {
  if (manifest.family !== "case_law") {
    return [];
  }
  const created = createdCaseLawBaseGroups(manifest);
  return CASE_LAW_INDEX_GROUP_NAMES.flatMap((indexGroup) => {
    const contract = resolveCorpusIndexGroupContract({ manifest, indexGroup });
    return contract.type === "base" && created.has(indexGroup)
      ? []
      : [registeredGroupOf(contract)];
  });
};

type CorpusIndexReadTargetOptions = {
  manifest: CorpusIndexManifest;
  jurisdiction: string | undefined;
  /** Registered groups whose current digest is attested. */
  attestedGroups: ReadonlySet<string>;
  /** Registered groups with an enrollment row, attested or not. */
  enrolledGroups: ReadonlySet<string>;
};

/**
 * The physical indexes a read reaches.
 *
 * A scoped read reaches its group's index, and only once that group is
 * attested if it is enrolled. A generation-wide case-law read names a bounded
 * set, by exact id wherever the index is known: the base groups the
 * generation was created with, and every registered group once attested
 * (`RegisteredCorpusIndexGroup`; attestation proves its index). An exact id
 * reaches nothing else named like it (a shadow or a stray index), and a group
 * without an index is left out rather than failing the read. Legislation
 * enrolls no group and keeps its wildcard.
 *
 * One bridge: a base group declared after the generation was created, with no
 * enrollment row yet, is named by the pattern over its own id, which reaches
 * its index if one was provisioned and skips it if not. The bridge ends once
 * the group is enrolled: from then on only its exact id counts, and only
 * while attested.
 */
export const corpusIndexReadTarget = ({
  manifest,
  jurisdiction,
  attestedGroups,
  enrolledGroups,
}: CorpusIndexReadTargetOptions): CorpusIndexReadTargetResolution => {
  if (jurisdiction !== undefined) {
    const contract = corpusIndexGroupContractForJurisdiction(
      manifest,
      jurisdiction,
    );
    if (contract.type !== "base" && !attestedGroups.has(contract.indexGroup)) {
      return { type: "unready", contract };
    }
    const route = corpusIndexRoute(manifest, jurisdiction);
    return {
      type: "ready",
      target: {
        route,
        contract,
        cursorTarget:
          contract.type === "base"
            ? null
            : readTargetIdentity(manifest, [
                { contract, name: route.indexId, reach: "exact" },
              ]),
      },
    };
  }
  if (manifest.family !== "case_law") {
    return {
      type: "ready",
      target: {
        route: corpusIndexRoute(manifest, undefined),
        contract: null,
        cursorTarget: null,
      },
    };
  }
  const created = createdCaseLawBaseGroups(manifest);
  const reached = CASE_LAW_INDEX_GROUP_NAMES.flatMap(
    (indexGroup): ReachedIndex[] => {
      const contract = resolveCorpusIndexGroupContract({
        manifest,
        indexGroup,
      });
      const exact = {
        contract,
        name: contract.indexId,
        reach: "exact",
      } as const;
      if (contract.type === "base" && created.has(indexGroup)) {
        return [exact];
      }
      if (contract.type === "base" && !enrolledGroups.has(indexGroup)) {
        return [{ contract, name: `${contract.indexId}*`, reach: "bridged" }];
      }
      return attestedGroups.has(indexGroup) ? [exact] : [];
    },
  );
  if (reached.length === 0) {
    return panic(`No readable index in ${manifest.generation}`);
  }
  return {
    type: "ready",
    target: {
      route: {
        indexId: reached.map(({ name }) => name).join(","),
        jurisdictionClause: undefined,
      },
      contract: null,
      cursorTarget: readTargetIdentity(manifest, reached),
    },
  };
};

/** The configuration the group's physical index is created with. */
export const corpusIndexGroupConfig = (
  contract: CorpusIndexGroupContract,
): CorpusIndexConfig =>
  corpusIndexConfigWithId(contract.indexConfig, contract.indexId);

/**
 * The partitions a court filter adds as a pruning predicate beside its exact
 * court clause, or undefined where it adds none.
 *
 * Only a read whose one target index is court-partitioned may name the
 * partition field: a generation-wide read (`contract` null) spans indexes
 * whose mapping has no such field, and an index created under its manifest's
 * contract does not map it either. The partition never replaces the exact
 * court clause, it only lets the engine skip splits; every document of the
 * court carries it (`requireCourtPartitionIdentity`), so the two clauses match
 * exactly what the court clause alone matches. A name the directory does not
 * carry adds no guessed partition and keeps its exact filter.
 */
export const courtPartitionsForCourtFilter = (
  contract: CorpusIndexGroupContract | null,
  court: string | undefined,
): readonly UsCourtPartition[] | undefined => {
  if (court === undefined || contract?.type !== "court_partition_v1") {
    return undefined;
  }
  const directoryCourt = US_COURT_BY_CANONICAL_NAME.get(court);
  return directoryCourt === undefined
    ? undefined
    : [directoryCourt.courtPartition];
};

export type CourtPartitionIdentity = {
  courtId: string;
  courtPartition: UsCourtPartition;
};

/**
 * The court identity a court-partitioned document is written under: its
 * accepted directory court and that court's partition. The stored court name
 * must be the directory's canonical name for the id, so the exact `court`
 * term and the partition can never name two different courts. Any other
 * state is a row the ingestion boundary should never have written, so it
 * fails the projection rather than guessing a partition.
 */
export const requireCourtPartitionIdentity = ({
  court,
  courtId,
}: {
  court: string;
  courtId: string | null;
}): CourtPartitionIdentity => {
  if (courtId === null) {
    return panic("Court-partitioned document has no court id");
  }
  const resolution = resolveUsCourt(courtId);
  if (resolution.type === "rejected") {
    return panic(
      `Court-partitioned document has a rejected court id: ${courtId}`,
    );
  }
  if (resolution.court.canonicalName !== court) {
    return panic(`Court name does not match the directory for ${courtId}`);
  }
  return { courtId, courtPartition: resolution.court.courtPartition };
};
