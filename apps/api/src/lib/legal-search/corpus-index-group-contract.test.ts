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
  corpusIndexReadTarget,
  registeredCorpusIndexGroups,
  courtPartitionsForCourtFilter,
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
import { caseLawCorpusQuery } from "@/api/lib/legal-search/corpus-query";

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

test("a court filter with its pruning predicate matches exactly what the court clause alone matches", () => {
  // A court's documents are written under its canonical name and the
  // partition of its id. The filter names the partition it derives from that
  // same name, so every document the exact court clause matches carries it:
  // the predicate removes splits, never results. Names are unique, so no name
  // can stand for two partitions.
  expect(
    new Set(US_COURTS.map(({ canonicalName }) => canonicalName)).size,
  ).toBe(US_COURTS.length);
  for (const manifest of CASE_LAW_MANIFESTS) {
    const contract = courtPartitionContract(manifest);
    const mismatched = US_COURTS.filter((court) => {
      const written = requireCourtPartitionIdentity({
        court: court.canonicalName,
        courtId: court.id,
      }).courtPartition;
      const filtered = courtPartitionsForCourtFilter(
        contract,
        court.canonicalName,
      );
      return filtered?.length !== 1 || filtered.at(0) !== written;
    });
    expect(mismatched).toEqual([]);
  }
  // A name the directory does not carry keeps its exact filter only.
  expect(
    courtPartitionsForCourtFilter(
      courtPartitionContract(CORPUS_INDEX_MANIFESTS.case_law_v7),
      "supreme court of the united states",
    ),
  ).toBeUndefined();
});

test("a read that reaches any index without the partition field never names it", () => {
  const names = [
    ...US_COURTS.slice(0, 50).map(({ canonicalName }) => canonicalName),
    "Supreme Court of the United States",
    "Nejvyšší soud",
  ];
  for (const manifest of CASE_LAW_MANIFESTS) {
    const legacy = CASE_LAW_INDEX_GROUP_NAMES.flatMap((indexGroup) => {
      const contract = resolveCorpusIndexGroupContract({
        manifest,
        indexGroup,
      });
      return contract.type === "base" ? [contract] : [];
    });
    // A generation-wide read spans every group, legacy ones included, so it
    // is a `null` target: only a read of one court-partitioned index prunes.
    for (const target of [null, ...legacy]) {
      for (const court of names) {
        const courtPartitions = courtPartitionsForCourtFilter(target, court);
        expect(courtPartitions).toBeUndefined();
        expect(
          caseLawCorpusQuery({
            text: "contract",
            filters: { court, courtPartitions, jurisdiction: "USA" },
          }),
        ).not.toContain(COURT_PARTITION_FIELD);
      }
    }
  }
});

/** What a Quickwit index-id target matches: `*` is any run, else literal. */
const matchesIndexTarget = (target: string, indexId: string): boolean =>
  target.split(",").some((name) =>
    new RegExp(
      `^${name
        .split("*")
        .map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
        .join(".*")}$`,
      "u",
    ).test(indexId),
  );

const globalTarget = (
  manifest: CorpusIndexManifest,
  { attested, enrolled }: { attested: string[]; enrolled: string[] },
) => {
  const resolution = corpusIndexReadTarget({
    manifest,
    jurisdiction: undefined,
    attestedGroups: new Set(attested),
    enrolledGroups: new Set(enrolled),
  });
  if (resolution.type !== "ready") {
    throw new Error("a global read is never refused");
  }
  return resolution.target;
};

test("a global read names created groups exactly and bridges a later group until it is enrolled", () => {
  for (const manifest of CASE_LAW_MANIFESTS) {
    const id = (group: string) => `${manifest.generation}_${group}`;

    // No registry row: HUN, declared after these generations were built, is
    // reached through the pattern over its own id, as the generation wildcard
    // reached it; USA, not attested, is not reached.
    const bridged = globalTarget(manifest, { attested: [], enrolled: [] });
    expect(bridged.route.indexId.split(",")).toEqual([
      id("aut"),
      id("cs_sk"),
      id("eu"),
      `${id("hun")}*`,
      id("pol"),
    ]);
    expect(matchesIndexTarget(bridged.route.indexId, id("hun"))).toBe(true);
    // Shadows and strays named like a created group are not reached.
    for (const stray of [
      `${id("cs_sk")}_shadow`,
      `${id("eu")}rope`,
      `${id("aut")}_old`,
      `${id("pol")}2`,
      id("usa"),
      `${id("usa")}_shadow`,
    ]) {
      expect([stray, matchesIndexTarget(bridged.route.indexId, stray)]).toEqual(
        [stray, false],
      );
    }

    // Enrolled but pending: the bridge has ended and nothing replaces it yet.
    const pending = globalTarget(manifest, {
      attested: [],
      enrolled: ["hun"],
    });
    expect(pending.route.indexId.split(",")).toEqual(
      ["aut", "cs_sk", "eu", "pol"].map(id),
    );
    expect(matchesIndexTarget(pending.route.indexId, id("hun"))).toBe(false);

    // Attested: HUN by its exact id, and USA once it is attested too.
    const attested = globalTarget(manifest, {
      attested: ["hun", "usa"],
      enrolled: ["hun", "usa"],
    });
    expect(attested.route.indexId.split(",")).toEqual(
      ["aut", "cs_sk", "eu", "hun", "pol", "usa"].map(id),
    );
    for (const stray of [`${id("hun")}_shadow`, `${id("usa")}_shadow`]) {
      expect(matchesIndexTarget(attested.route.indexId, stray)).toBe(false);
    }

    // The cursor binds each index and how it is named: bridged and exact
    // HUN are different targets, and so is the set without it.
    const exactHun = globalTarget(manifest, {
      attested: ["hun"],
      enrolled: ["hun"],
    });
    const identities = [bridged, pending, exactHun, attested].map(
      ({ cursorTarget }) => cursorTarget,
    );
    for (const identity of identities) {
      expect(identity).toMatch(/^[0-9a-f]{32}$/u);
    }
    expect(new Set(identities).size).toBe(identities.length);
  }
  // A bridged pattern reaches only its own group: no declared group's name
  // extends another's.
  for (const group of CASE_LAW_INDEX_GROUP_NAMES) {
    for (const other of CASE_LAW_INDEX_GROUP_NAMES) {
      expect([
        group,
        other,
        other !== group && other.startsWith(group),
      ]).toEqual([group, other, false]);
    }
  }
});

test("scoped reads resolve apart from the registry's bridge", () => {
  // A scoped read of the enrolled group before attestation is refused.
  expect(
    corpusIndexReadTarget({
      manifest: CORPUS_INDEX_MANIFESTS.case_law_v7,
      jurisdiction: "USA",
      attestedGroups: new Set(),
      enrolledGroups: new Set(),
    }).type,
  ).toBe("unready");
  // A scoped read of a base group keeps its route and its legacy cursor form,
  // attested or not.
  expect(
    corpusIndexReadTarget({
      manifest: CORPUS_INDEX_MANIFESTS.case_law_v7,
      jurisdiction: "HUN",
      attestedGroups: new Set(),
      enrolledGroups: new Set(),
    }),
  ).toMatchObject({
    type: "ready",
    target: {
      route: { indexId: "case_law_v7_hun" },
      cursorTarget: null,
    },
  });
  // Legislation enrolls no group and keeps its wildcard.
  expect(
    corpusIndexReadTarget({
      manifest: CORPUS_INDEX_MANIFESTS.legislation_v2,
      jurisdiction: undefined,
      attestedGroups: new Set(),
      enrolledGroups: new Set(),
    }),
  ).toEqual({
    type: "ready",
    target: {
      route: { indexId: "legislation_v2_*", jurisdictionClause: undefined },
      contract: null,
      cursorTarget: null,
    },
  });
});

test("the registry records exactly the groups a manifest cannot vouch for", () => {
  for (const manifest of CASE_LAW_MANIFESTS) {
    expect(
      registeredCorpusIndexGroups(manifest).map(
        ({ indexGroup, contractVersion }) => [indexGroup, contractVersion],
      ),
    ).toEqual([
      ["hun", "base"],
      ["usa", "court_partition_v1"],
    ]);
  }
  expect(
    registeredCorpusIndexGroups(CORPUS_INDEX_MANIFESTS.legislation_v2),
  ).toEqual([]);
});

test("each generation's USA contract gives its cursors an identity of their own", () => {
  const identities = CASE_LAW_MANIFESTS.map((manifest) => {
    const resolution = corpusIndexReadTarget({
      manifest,
      jurisdiction: "USA",
      attestedGroups: new Set(["usa"]),
      enrolledGroups: new Set(["usa"]),
    });
    return resolution.type === "ready" ? resolution.target.cursorTarget : null;
  });
  expect(identities.every((identity) => identity !== null)).toBe(true);
  // A replacement generation's cursor never continues the previous one's.
  expect(new Set(identities).size).toBe(identities.length);
});
