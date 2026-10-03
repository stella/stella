/**
 * The fingerprint change detection compares for a case-law decision.
 *
 * A re-fetched decision is written over the stored row only when its
 * `rawHash` differs from the stored one, so the hash decides whether a
 * publisher's correction reaches the corpus at all. It therefore has to be a
 * function of every byte the pipeline stores for the decision: the envelope
 * text and each binary object stored beside it. A hash over the docket, the
 * date or parsed fields calls a corrected document unchanged, and a hash over
 * the envelope alone does the same for a corrected file stored beside it.
 *
 * This module is the only constructor of {@link SourceFingerprint}. It takes
 * the stored fields themselves rather than a list of strings, so what is
 * hashed and what is stored cannot drift apart.
 */

import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";

declare const sourceFingerprintProof: unique symbol;

/** A SHA-256 hex digest over every stored raw byte of one decision. */
export type SourceFingerprint = string & {
  readonly [sourceFingerprintProof]: true;
};

/** What the pipeline stores as a decision's raw source. */
export type StoredSourceRaw = {
  /** The envelope text, as the adapter encoded it (before object addresses are filled in). */
  readonly sourceRaw: string;
  readonly sourceRawObjects?: IngestionResult["sourceRawObjects"];
};

const sha256Hex = (input: string | Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(input).digest("hex");

/**
 * Fingerprint the envelope and every object stored beside it.
 *
 * Objects contribute the digest of their bytes in the order the adapter lists
 * them. With no objects the fingerprint is the digest of the envelope alone,
 * which is the value adapters that store only text have always written, so
 * adopting this owner does not change a stored hash.
 */
export const sourceFingerprint = ({
  sourceRaw,
  sourceRawObjects,
}: StoredSourceRaw): SourceFingerprint => {
  const objects = Object.values(sourceRawObjects ?? {}).map(({ bytes }) =>
    sha256Hex(bytes),
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the brand's only constructor
  return sha256Hex([sourceRaw, ...objects].join("\n")) as SourceFingerprint;
};
