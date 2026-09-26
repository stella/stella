import { expect, test } from "bun:test";

import {
  resolveUsCourt,
  US_COURT_PARTITIONS,
  US_COURTS,
} from "@stll/api-contract/us-courts";

import {
  CASE_LAW_INDEX_GROUP_CONTRACT_OF,
  CASE_LAW_INDEX_GROUP_NAMES,
} from "@/api/lib/legal-search/case-law-index-groups";
import { TAG_FIELD_VALUE_LIMIT } from "@/api/lib/legal-search/corpus-index-config";
import {
  COURT_PARTITION_FIELD,
  corpusIndexGroupConfig,
  corpusIndexGroupContractForJurisdiction,
  enrolledCorpusIndexGroupContracts,
  requireCourtPartitionIdentity,
  resolveCorpusIndexGroupContract,
  type CourtPartitionGroupContract,
} from "@/api/lib/legal-search/corpus-index-group-contract";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexConfigFromManifest,
  corpusIndexIdFromManifest,
  type CorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";

const CASE_LAW_MANIFESTS = [
  CORPUS_INDEX_MANIFESTS.case_law_v5,
  CORPUS_INDEX_MANIFESTS.case_law_v6,
  CORPUS_INDEX_MANIFESTS.case_law_v7,
] as const;

const courtPartitionContract = (
  manifest: CorpusIndexManifest,
): CourtPartitionGroupContract => {
  const contract = resolveCorpusIndexGroupContract({
    manifest,
    indexGroup: "usa",
  });
  if (contract.type !== "court_partition_v1") {
    throw new Error(`usa resolved to ${contract.type}`);
  }
  return contract;
};

/**
 * The effective-contract census. An enrolled group's digest is what its
 * enrollment binds and its physical index is attested against, so it moves
 * only when the base manifest or the group contract deliberately does.
 */
const EXPECTED_EFFECTIVE_DIGESTS = {
  case_law_v5:
    "af47875d3ccbcac95210c77762a0d9ce343108de2286375a105b35cd092254e6",
  case_law_v6:
    "2938ba381346438f59c7edd2310be5e473a1756e48aed90deacdca1bd2954633",
  case_law_v7:
    "2051cf7ac46b05d168bdf3f0fc279788facda36cd52cb0d3ca6f4d79969a685a",
} as const;

test("every group declared before a group contract keeps its manifest's exact configuration", () => {
  const baseGroups = CASE_LAW_INDEX_GROUP_NAMES.filter(
    (group) => CASE_LAW_INDEX_GROUP_CONTRACT_OF[group] === "base",
  );
  expect(baseGroups.toSorted()).toEqual(["aut", "cs_sk", "eu", "hun", "pol"]);
  for (const manifest of CASE_LAW_MANIFESTS) {
    for (const indexGroup of baseGroups) {
      const contract = resolveCorpusIndexGroupContract({
        manifest,
        indexGroup,
      });
      expect(contract.type).toBe("base");
      // Byte for byte: the configuration Plane creates and attests is the one
      // the manifest produced before any group contract existed.
      expect(JSON.stringify(corpusIndexGroupConfig(contract))).toBe(
        JSON.stringify(
          corpusIndexConfigFromManifest(manifest, contract.indexId),
        ),
      );
    }
  }
  const legislation = corpusIndexGroupContractForJurisdiction(
    CORPUS_INDEX_MANIFESTS.legislation_v2,
    "CZE",
  );
  expect(legislation.type).toBe("base");
  expect(
    enrolledCorpusIndexGroupContracts(CORPUS_INDEX_MANIFESTS.legislation_v2),
  ).toEqual([]);
});

test("the effective-contract digest is pinned per generation and apart from the manifest's", () => {
  for (const manifest of CASE_LAW_MANIFESTS) {
    const contract = courtPartitionContract(manifest);
    expect(contract.effectiveDigest).toBe(
      EXPECTED_EFFECTIVE_DIGESTS[manifest.generation],
    );
    expect(contract.artifact.baseManifestDigest).not.toBe(
      contract.effectiveDigest,
    );
    expect(enrolledCorpusIndexGroupContracts(manifest)).toEqual([contract]);
  }
});

test("the court-partitioned group swaps the court tag for a partition and changes nothing else", () => {
  for (const manifest of CASE_LAW_MANIFESTS) {
    const contract = courtPartitionContract(manifest);
    const base = manifest.engine.indexConfig;
    const effective = corpusIndexGroupConfig(contract);
    expect(effective.index_id).toBe(corpusIndexIdFromManifest(manifest, "USA"));

    const mapping = effective.doc_mapping;
    expect(mapping.partition_key).toBe(COURT_PARTITION_FIELD);
    expect(mapping.tag_fields).toEqual([
      ...base.doc_mapping.tag_fields.filter((field) => field !== "court"),
      COURT_PARTITION_FIELD,
    ]);
    // The court keeps its exact mapping: the exact filter needs it indexed
    // and raw, the court facet needs it fast.
    const court = mapping.field_mappings.find(({ name }) => name === "court");
    expect(court).toEqual(
      base.doc_mapping.field_mappings.find(({ name }) => name === "court"),
    );
    expect(court).toMatchObject({
      tokenizer: "raw",
      indexed: true,
      fast: true,
    });
    expect(
      mapping.field_mappings.find(({ name }) => name === COURT_PARTITION_FIELD),
    ).toMatchObject({ type: "text", tokenizer: "raw", indexed: true });

    // Everything else is the base configuration.
    const {
      doc_mapping: {
        partition_key: _partitionKey,
        tag_fields: _tags,
        field_mappings: fields,
        ...restMapping
      },
      index_id: _indexId,
      ...rest
    } = effective;
    const {
      doc_mapping: {
        tag_fields: _baseTags,
        field_mappings: baseFields,
        ...baseRestMapping
      },
      index_id: _baseIndexId,
      ...baseRest
    } = corpusIndexConfigFromManifest(manifest, "unrelated_index");
    expect(rest).toEqual(baseRest);
    expect(restMapping).toEqual(baseRestMapping);
    expect(fields.filter(({ name }) => name !== COURT_PARTITION_FIELD)).toEqual(
      baseFields,
    );
    // The partition bound admits every partition value without coalescing.
    expect(mapping.max_num_partitions ?? 0).toBeGreaterThan(
      US_COURT_PARTITIONS.length,
    );
  }
});

test("each effective tag field is bounded where its group tags it", () => {
  // `court` is argued per group in corpus-index-config.test.ts, and only
  // where the group's effective contract still tags it. The partition that
  // replaces it is bounded by construction.
  for (const manifest of CASE_LAW_MANIFESTS) {
    for (const indexGroup of CASE_LAW_INDEX_GROUP_NAMES) {
      const contract = resolveCorpusIndexGroupContract({
        manifest,
        indexGroup,
      });
      const tags = corpusIndexGroupConfig(contract).doc_mapping.tag_fields;
      expect([indexGroup, tags.includes("court")]).toEqual([
        indexGroup,
        contract.type === "base",
      ]);
      expect([indexGroup, tags.includes(COURT_PARTITION_FIELD)]).toEqual([
        indexGroup,
        contract.type === "court_partition_v1",
      ]);
    }
  }
  expect(
    new Set(US_COURTS.map(({ courtPartition }) => courtPartition)).size,
  ).toBeLessThanOrEqual(US_COURT_PARTITIONS.length);
  expect(US_COURT_PARTITIONS.length).toBeLessThan(TAG_FIELD_VALUE_LIMIT / 2);
});

test("the manifest's own configuration is refused for a group under another contract", () => {
  for (const manifest of CASE_LAW_MANIFESTS) {
    expect(() =>
      corpusIndexConfigFromManifest(manifest, `${manifest.generation}_usa`),
    ).toThrow("court_partition_v1 group contract");
  }
});

test("a court-partitioned document is written only under its exact directory identity", () => {
  const scotus = resolveUsCourt("scotus");
  if (scotus.type !== "accepted") {
    throw new Error("scotus is not an accepted court");
  }
  expect(
    requireCourtPartitionIdentity({
      court: scotus.court.canonicalName,
      courtId: "scotus",
    }),
  ).toEqual({ courtId: "scotus", courtPartition: scotus.court.courtPartition });
  expect(() =>
    requireCourtPartitionIdentity({
      court: scotus.court.canonicalName,
      courtId: null,
    }),
  ).toThrow("no court id");
  expect(() =>
    requireCourtPartitionIdentity({
      court: scotus.court.canonicalName,
      courtId: "SCOTUS",
    }),
  ).toThrow("rejected court id");
  expect(() =>
    requireCourtPartitionIdentity({
      court: "Supreme Court",
      courtId: "scotus",
    }),
  ).toThrow("does not match the directory");
});
