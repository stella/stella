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

import { sha256Hex } from "@stll/sha256/bun";

import type { ListingIdentity } from "@/api/lib/legal-search/ingestion-types";

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

export type QuarantineIdentity = {
  /** The bare SHA-256 hex digest, for labels and URL fragments. */
  readonly fingerprint: string;
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
  return {
    fingerprint,
    sourceDocumentId: quarantineSourceDocumentId(namespace, fingerprint),
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
