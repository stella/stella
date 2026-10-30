// parser-output-unchanged: [cz-us] reproduces the adapter's former quarantine digest byte for byte.
/**
 * The identity of a listed record that states no usable publisher id.
 *
 * Case-law AGENTS.md rule 20: once a publisher lists a record, the crawl
 * keeps it, listing-only if need be. A record without a persistable
 * publisher id still has to be stored under some exact `sourceDocumentId`,
 * or the reconciliation can neither count it as reported nor see it as
 * collected and its payload is lost. This module is the one constructor of
 * that identity: `<namespace>-quarantine:<sha256>` over the fields the
 * adapter declares stable for the record.
 *
 * Stable means the value is the same every time the publisher lists the same
 * record, and stays the same once its publisher id recovers, so the recovered
 * observation can emit the fingerprint as a repair alias and take over the
 * quarantined row. Listing position, render markup, search highlight markers,
 * update timestamps and the malformed identity itself are therefore never
 * stable fields: each one moves while the record does not.
 */

import { panic } from "better-result";
import * as v from "valibot";

import { sha256Hex } from "@stll/sha256/bun";

import type { CompleteReconciliationScope } from "@/api/handlers/case-law/ingestion/slice-listing";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";
import type {
  IngestionResult,
  ListingIdentity,
} from "@/api/lib/legal-search/ingestion-types";
import type { ListingObservationReason } from "@/api/lib/legal-search/listing-observation-reasons";
import { fingerprintReconciliationPayload } from "@/api/lib/legal-search/reconciliation-payload";

export {
  LISTING_OBSERVATION_REASON,
  LISTING_OBSERVATION_REASONS,
} from "@/api/lib/legal-search/listing-observation-reasons";
export type { ListingObservationReason } from "@/api/lib/legal-search/listing-observation-reasons";

/**
 * Quarantine namespaces, one per adapter that builds the identity. The
 * namespace is the identity's prefix, so two adapters sharing one would let
 * one source's quarantine row adopt another's.
 *
 * `nalus` predates this module: stored Constitutional Court rows carry it.
 */
export const QUARANTINE_NAMESPACE = {
  CZ_NS: "cz-ns",
  CZ_NSS: "cz-nss",
  CZ_REGIONAL: "cz-regional",
  CZ_UOHS: "cz-uohs",
  CZ_US: "nalus",
  EU_ECJ: "eu-ecj",
  HU_BHGY: "hu-bhgy",
  PL_COURTS: "pl-courts",
  PL_NCOURT: "pl-ncourt",
  PL_SN: "pl-sn",
  PL_TK: "pl-tk",
  PL_UODO: "pl-uodo",
  PL_UOKIK: "pl-uokik",
  SK_COURTS: "sk-courts",
  SK_US: "sk-us",
} as const;

export type QuarantineNamespace =
  (typeof QUARANTINE_NAMESPACE)[keyof typeof QUARANTINE_NAMESPACE];

/**
 * Field name to the value the publisher states for it; `undefined` for a
 * field the record does not state, which leaves the field out of the
 * fingerprint. Key order is part of the fingerprint: declare the fields in
 * one fixed order at the call site.
 */
export type QuarantineStableFields = Readonly<
  Record<string, string | undefined>
>;

const repairAliasSchema = v.pipe(v.string(), v.brand("RepairAlias"));

/** An adoption candidate, distinct from a stored quarantine identity. */
export type RepairAlias = v.InferOutput<typeof repairAliasSchema>;

export const LEGACY_REPAIR_NAMESPACE = {
  AT_COURTS: "ris",
  AT_FINDOK: "findok",
  PL_KIO: "pl-kio",
  PL_KIS: "pl-kis",
  PL_NSA: "pl-nsa",
  PL_NCOURT_LISTED: "ncourt-listed",
  SK_COURTS_PLAINTEXT: "sk-courts-plaintext",
} as const;

type RepairNamespace =
  | QuarantineNamespace
  | (typeof LEGACY_REPAIR_NAMESPACE)[keyof typeof LEGACY_REPAIR_NAMESPACE];

/** Only fields present in the fingerprint may qualify that form for adoption. */
const REPAIR_DISCRIMINATORS = {
  "cz-ns": [],
  "cz-nss": ["reference"],
  "cz-regional": ["docket"],
  "cz-uohs": ["referenceNumber"],
  nalus: ["stableDetailText"],
  "eu-ecj": ["ecli"],
  "hu-bhgy": ["docket"],
  "pl-courts": ["docket"],
  "pl-ncourt": ["thesis"],
  "pl-sn": ["docket"],
  "pl-tk": [],
  "pl-uodo": ["refname"],
  "pl-uokik": ["decisionNumber"],
  "sk-courts": ["spisovaZnacka", "identifikacneCislo"],
  "sk-us": ["mkRSAPNumberOfFile", "mkRVPNumberOfFile"],
  ris: ["caseNumbers"],
  findok: ["stammNr", "pathPdf", "pathZip", "gz"],
  "pl-kio": ["signature"],
  "pl-kis": ["signature", "thesis"],
  "pl-nsa": ["docket_number"],
  "ncourt-listed": ["signature", "excerpt"],
  "sk-courts-plaintext": ["caseNumber"],
} as const satisfies Record<RepairNamespace, readonly string[]>;

type CourtProvenancePolicy =
  | { readonly type: "single-court" | "single-authority" }
  | { readonly type: "multi-court"; readonly fields: readonly string[] };

/** Fields must belong to the captured fingerprint, never a recovered detail. */
const REPAIR_COURT_PROVENANCE = {
  "cz-ns": { type: "single-court" },
  "cz-nss": { type: "multi-court", fields: ["court"] },
  "cz-regional": { type: "multi-court", fields: ["court"] },
  "cz-us": { type: "single-court" },
  "cz-uohs": { type: "single-authority" },
  "sk-courts": { type: "multi-court", fields: ["sud", "sudRegistreGuid"] },
  "sk-us": { type: "single-court" },
  "pl-courts": { type: "multi-court", fields: ["court"] },
  "pl-sn": { type: "single-court" },
  "pl-kio": { type: "multi-court", fields: ["court"] },
  "pl-tk": { type: "single-court" },
  "pl-nsa": { type: "multi-court", fields: ["court_name"] },
  "pl-ncourt": { type: "multi-court", fields: ["courtId"] },
  "at-courts": { type: "multi-court", fields: ["court"] },
  "at-vfgh": { type: "single-court" },
  "at-vwgh": { type: "single-court" },
  "at-bvwg": { type: "single-court" },
  "at-lvwg": { type: "multi-court", fields: ["court"] },
  "at-asylgh": { type: "single-court" },
  "at-ubas": { type: "single-court" },
  "at-uvs": { type: "multi-court", fields: ["court"] },
  "at-verg": { type: "multi-court", fields: ["court"] },
  "at-umse": { type: "single-court" },
  "at-bks": { type: "single-court" },
  "at-findok": { type: "multi-court", fields: ["behoerde"] },
  "eu-ecj": { type: "multi-court", fields: ["ecli"] },
  "hu-bhgy": { type: "multi-court", fields: ["court"] },
  "uk-fcl": { type: "multi-court", fields: ["court"] },
  "pl-kis": { type: "single-authority" },
  "pl-uodo": { type: "multi-court", fields: ["name", "subtype"] },
  "pl-uokik": { type: "single-authority" },
} as const satisfies Record<AdapterKey, CourtProvenancePolicy>;

const REPAIR_ADAPTERS = {
  "cz-ns": "cz-ns",
  "cz-nss": "cz-nss",
  "cz-regional": "cz-regional",
  "cz-uohs": "cz-uohs",
  nalus: "cz-us",
  "eu-ecj": "eu-ecj",
  "hu-bhgy": "hu-bhgy",
  "pl-courts": "pl-courts",
  "pl-ncourt": "pl-ncourt",
  "pl-sn": "pl-sn",
  "pl-tk": "pl-tk",
  "pl-uodo": "pl-uodo",
  "pl-uokik": "pl-uokik",
  "sk-courts": "sk-courts",
  "sk-us": "sk-us",
  ris: "at-courts",
  findok: "at-findok",
  "pl-kio": "pl-kio",
  "pl-kis": "pl-kis",
  "pl-nsa": "pl-nsa",
  "ncourt-listed": "pl-ncourt",
  "sk-courts-plaintext": "sk-courts",
} as const satisfies Record<RepairNamespace, AdapterKey>;

type RepairAliasesForStableFieldsOptions = {
  namespace: RepairNamespace;
  sourceDocumentIds: readonly string[];
  stableFields: QuarantineStableFields;
};

/** General metadata still identifies a stored observation, but cannot adopt a decision. */
export const repairAliasesForStableFields = ({
  namespace,
  sourceDocumentIds,
  stableFields,
}: RepairAliasesForStableFieldsOptions): RepairAlias[] => {
  const stated = (field: string): boolean =>
    (stableFields[field]?.trim().length ?? 0) > 0;
  const policy = REPAIR_COURT_PROVENANCE[REPAIR_ADAPTERS[namespace]];
  if (policy.type === "multi-court" && !policy.fields.some(stated)) {
    return [];
  }
  return REPAIR_DISCRIMINATORS[namespace].some(stated)
    ? sourceDocumentIds.map((identity) => v.parse(repairAliasSchema, identity))
    : [];
};

export type QuarantineIdentity = {
  /** The bare SHA-256 hex digest, for labels and URL fragments. */
  readonly fingerprint: string;
  readonly repairAliases: readonly RepairAlias[];
  /** `<namespace>-quarantine:<fingerprint>`, what the row is stored under. */
  readonly sourceDocumentId: string;
};

type QuarantineIdentityOptions = {
  namespace: QuarantineNamespace;
  stableFields: QuarantineStableFields;
};

/** What every quarantine id of a namespace starts with, for a SQL prefix match. */
export const quarantinePrefix = (namespace: QuarantineNamespace): string =>
  `${namespace}-quarantine:`;

// Existing national-court rows predate the shared quarantine namespace.
const QUARANTINE_PREFIXES = [
  ...Object.values(QUARANTINE_NAMESPACE).map(quarantinePrefix),
  "ncourt-listed:",
];

/**
 * Whitespace is the one rendering difference normalised away: publishers
 * reflow the same text across pages and exports, and a run of spaces carries
 * no meaning in a stable field.
 */
const normalizeStableValue = (value: string): string =>
  value.replace(/\s+/gu, " ").trim();

/**
 * The stored form of a fingerprint computed earlier, for an adapter that
 * keeps bare fingerprints in its listing payload and emits them as repair
 * aliases later.
 */
export const quarantineSourceDocumentId = (
  namespace: QuarantineNamespace,
  fingerprint: string,
): string => `${quarantinePrefix(namespace)}${fingerprint}`;

export const quarantineIdentity = ({
  namespace,
  stableFields,
}: QuarantineIdentityOptions): QuarantineIdentity => {
  const fingerprint = sha256Hex(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(stableFields).map(([field, value]) => [
          field,
          value === undefined ? undefined : normalizeStableValue(value),
        ]),
      ),
    ),
  );
  const sourceDocumentId = quarantineSourceDocumentId(namespace, fingerprint);
  return {
    fingerprint,
    sourceDocumentId,
    repairAliases: repairAliasesForStableFields({
      namespace,
      sourceDocumentIds: [sourceDocumentId],
      stableFields,
    }),
  };
};

/** Whether a stored identity is one this namespace quarantined. */
export const isQuarantineSourceDocumentId = (
  namespace: QuarantineNamespace,
  sourceDocumentId: string,
): boolean => sourceDocumentId.startsWith(quarantinePrefix(namespace));

type QuarantineObservation = {
  readonly sourceDocumentId: string;
  /** What distinguishes one record's content from another's. */
  readonly revision: string;
};

/**
 * Per quarantine id, how many records beyond the first were observed under
 * it: the distinct revisions past the first.
 *
 * A publisher id names one document however often it is listed, so a repeat
 * is a duplicate. A quarantine id is only as distinct as the fields it hashes:
 * two records whose stable fields agree share it, only one row can be stored,
 * and the second observation would silently replace the first (case-law
 * AGENTS.md rule 17). The callers report these instead of folding them into
 * duplicates. Observations under publisher ids are ignored.
 */
export const countQuarantineCollisions = (
  observations: Iterable<QuarantineObservation>,
): Map<string, number> => {
  const revisions = new Map<string, Set<string>>();
  for (const { sourceDocumentId, revision } of observations) {
    if (!isQuarantineListingIdentity({ type: "document", sourceDocumentId })) {
      continue;
    }
    const seen = revisions.get(sourceDocumentId) ?? new Set<string>();
    seen.add(revision);
    revisions.set(sourceDocumentId, seen);
  }
  const collisions = new Map<string, number>();
  for (const [sourceDocumentId, seen] of revisions) {
    if (seen.size > 1) {
      collisions.set(sourceDocumentId, seen.size - 1);
    }
  }
  return collisions;
};

type QuarantinePeerObservation = {
  readonly sourceDocumentId: string;
  /**
   * For a record keyed on a publisher id, the quarantine ids an id-less
   * listing of it would get; absent for any other record.
   */
  readonly quarantinePeers?: readonly string[] | undefined;
};

/**
 * The quarantine ids observed both as a quarantined record and as the peer
 * of a keyed record in the same listing.
 *
 * Within one listing such a pair is two records, a keyed one and an id-less
 * one, whose stable fields agree: the fingerprint cannot tell them apart, so
 * adopting the quarantined row on the keyed record's recovery would merge two
 * documents. Reported so the adapter's stable fields can be made more
 * specific; nothing is merged or dropped here.
 */
export const quarantinePeerCollisions = (
  observations: readonly QuarantinePeerObservation[],
): string[] => {
  const quarantined = new Set(
    observations.flatMap(({ sourceDocumentId }) =>
      isQuarantineListingIdentity({ type: "document", sourceDocumentId })
        ? [sourceDocumentId]
        : [],
    ),
  );
  return [
    ...new Set(
      observations.flatMap(({ quarantinePeers }) =>
        quarantinePeers === undefined
          ? []
          : quarantinePeers.filter((peer) => quarantined.has(peer)),
      ),
    ),
  ];
};

/**
 * Whether a listing identity is a quarantine identity of any namespace.
 *
 * Such a record is complete as its listing row: with no publisher id there
 * is no detail to ask the publisher for, so the reconciliation counts its
 * listing-only row as held rather than hunting a document no request can
 * name. It is completed when the publisher id recovers: that observation
 * lists under the recovered id and takes the row over by its repair alias.
 */
export const isQuarantineListingIdentity = (
  identity: ListingIdentity,
): boolean =>
  identity.type === "document" &&
  QUARANTINE_PREFIXES.some((prefix) =>
    identity.sourceDocumentId.startsWith(prefix),
  );

export type CollisionFilterProof =
  CompleteReconciliationScope | { readonly type: "no-listing-proof" };

const collisionFilteredDecisionsBrand = Symbol("CollisionFilteredDecisions");

/** Only this owner can construct the decisions accepted by page apply paths. */
export type CollisionFilteredDecisions = {
  readonly [collisionFilteredDecisionsBrand]: true;
  readonly decisions: readonly IngestionResult[];
  readonly collidingIds: readonly string[];
};

type FilterQuarantinePeerCollisionsOptions = {
  decisions: readonly IngestionResult[];
  proof: CollisionFilterProof;
};

/** A captured peer remains a separate record; absent listing proof cannot authorize adoption. */
export const filterQuarantinePeerCollisions = ({
  decisions,
  proof,
}: FilterQuarantinePeerCollisionsOptions): CollisionFilteredDecisions => {
  switch (proof.type) {
    case "complete-scope": {
      const collidingIds = quarantinePeerCollisions([
        ...proof.listedIdentities.flatMap((identity) =>
          identity.type === "document"
            ? [{ sourceDocumentId: identity.sourceDocumentId }]
            : [],
        ),
        ...decisions.map((decision) => ({
          sourceDocumentId: decision.sourceDocumentId ?? "",
          quarantinePeers: decision.sourceDocumentIdRepairAliases,
        })),
      ]);
      const colliding = new Set(collidingIds);
      return {
        [collisionFilteredDecisionsBrand]: true,
        decisions:
          colliding.size === 0
            ? decisions
            : decisions.map((decision) => ({
                ...decision,
                sourceDocumentIdRepairAliases:
                  decision.sourceDocumentIdRepairAliases?.filter(
                    (alias) => !colliding.has(alias),
                  ),
              })),
        collidingIds,
      };
    }
    case "no-listing-proof":
      return {
        [collisionFilteredDecisionsBrand]: true,
        decisions: decisions.map((decision) => ({
          ...decision,
          sourceDocumentIdRepairAliases: [],
        })),
        collidingIds: [],
      };
    default: {
      proof satisfies never;
      return panic("Unknown listing proof");
    }
  }
};

/** A captured listing is evidence, never a canonical decision identity. */
const listingObservationIdentitySchema = v.pipe(
  v.object({
    source: v.picklist([
      QUARANTINE_NAMESPACE.SK_US,
      QUARANTINE_NAMESPACE.PL_COURTS,
    ]),
    fingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  }),
  v.brand("ListingObservationIdentity"),
);

export type ListingObservationIdentity = v.InferOutput<
  typeof listingObservationIdentitySchema
>;

export type ListingObservation = {
  readonly identity: ListingObservationIdentity;
  readonly reason: ListingObservationReason;
  /** The record exactly as the listing exposed it, including malformed fields. */
  readonly payload: unknown;
};

type QuarantinedListingObservationOptions = {
  source: ListingObservationIdentity["source"];
  payload: unknown;
  reason: ListingObservationReason;
};

/** Content addressing makes replay a fixed point without deciding which court record it is. */
export const quarantinedListingObservation = ({
  source,
  payload,
  reason,
}: QuarantinedListingObservationOptions): ListingObservation => ({
  identity: v.parse(listingObservationIdentitySchema, {
    source,
    fingerprint: fingerprintReconciliationPayload({ source, payload }),
  }),
  reason,
  payload,
});
