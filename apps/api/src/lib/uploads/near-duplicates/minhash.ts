/**
 * MinHash signatures and LSH band keys for near-duplicate documents.
 *
 * A document is reduced to the set of its overlapping 5-word shingles over
 * search-folded text, so a DOCX and its scanned PDF, or two exports of one
 * draft, produce (almost) the same set. Each of the 128 hash functions keeps
 * the smallest hash over that set; the share of equal slots between two
 * signatures estimates the Jaccard similarity of the shingle sets.
 *
 * The hash functions are seeded from a per-organization key, so the same
 * text gives unrelated signatures in two organizations and signatures are
 * never comparable across them.
 *
 * Candidates are found with 21 bands of 6 rows (126 of the 128 slots): two
 * documents share a band key with probability 1 - (1 - s^6)^21, which is
 * about 93% at the 0.7 threshold, 99.8% at 0.8 and 0.5% at 0.25.
 *
 * The values were tuned on the license corpus in `corpus.test.ts`, whose
 * report gives the measured numbers. Unrelated documents of one type stay
 * below 0.25 there for any shingle size from 3 to 7 words, while one license
 * under two copyright holders sits near 0.8; 0.7 keeps both margins wide.
 */

/* oxlint-disable no-bitwise -- 32-bit hashing is the algorithm. */

import { foldSearchMatchText } from "@stll/text-normalize";

export const SHINGLE_WORDS = 5;
export const SIGNATURE_LENGTH = 128;
export const LSH_BANDS = 21;
const LSH_ROWS = 6;

/** Shorter texts share too much boilerplate to call a match meaningful. */
export const MIN_WORDS = 50;

export const NEAR_DUPLICATE_THRESHOLD = 0.7;

const WORD_RE = /[\p{L}\p{N}]+/gu;

const fnv1a = (text: string): number => {
  let hash = 0x81_1c_9d_c5;
  for (const character of text) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 0x01_00_01_93);
  }
  return hash >>> 0;
};

// murmur3 fmix32: spreads a seeded value over all 32 bits.
const mix = (value: number): number => {
  let hash = value;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85_eb_ca_6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2_b2_ae_35);
  return (hash ^ (hash >>> 16)) >>> 0;
};

/** `key` is the organization's lookup key (`contentLookupKey`). */
export const minHashSeeds = (key: string): Uint32Array =>
  Uint32Array.from({ length: SIGNATURE_LENGTH }, (_, index) =>
    mix(fnv1a(`${key}\u0000${index}`)),
  );

export const shingleHashes = (text: string): Set<number> | null => {
  const words = Array.from(
    foldSearchMatchText(text).matchAll(WORD_RE),
    ([word]) => word,
  );
  if (words.length < MIN_WORDS) {
    return null;
  }
  const hashes = new Set<number>();
  for (let index = 0; index + SHINGLE_WORDS <= words.length; index++) {
    hashes.add(fnv1a(words.slice(index, index + SHINGLE_WORDS).join(" ")));
  }
  return hashes;
};

/** `null` when the text is too short to compare. */
export const minHashSignature = (
  text: string,
  seeds: Uint32Array,
): Uint32Array | null => {
  const shingles = shingleHashes(text);
  if (!shingles) {
    return null;
  }
  const signature = new Uint32Array(SIGNATURE_LENGTH).fill(0xff_ff_ff_ff);
  for (const shingle of shingles) {
    for (let slot = 0; slot < SIGNATURE_LENGTH; slot++) {
      const hash = mix(shingle ^ (seeds[slot] ?? 0));
      if (hash < (signature[slot] ?? 0)) {
        signature[slot] = hash;
      }
    }
  }
  return signature;
};

/** Little-endian, so stored signatures do not depend on the host. */
export const signatureToBytes = (signature: Uint32Array): Buffer => {
  const bytes = Buffer.alloc(SIGNATURE_LENGTH * 4);
  for (const [slot, value] of signature.entries()) {
    bytes.writeUInt32LE(value, slot * 4);
  }
  return bytes;
};

export const signatureFromBytes = (bytes: Uint8Array): Uint32Array => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Uint32Array.from({ length: SIGNATURE_LENGTH }, (_, slot) =>
    view.getUint32(slot * 4, true),
  );
};

export const estimateSimilarity = (
  left: Uint32Array,
  right: Uint32Array,
): number => {
  let equal = 0;
  for (let slot = 0; slot < SIGNATURE_LENGTH; slot++) {
    if (left[slot] === right[slot]) {
      equal++;
    }
  }
  return equal / SIGNATURE_LENGTH;
};

const bandHash = (signature: Uint32Array, band: number, salt: number) => {
  let hash = mix(band + salt);
  for (let row = 0; row < LSH_ROWS; row++) {
    hash = mix(hash ^ (signature[band * LSH_ROWS + row] ?? 0));
  }
  return BigInt(hash);
};

/**
 * One signed 64-bit key per band, ready for a Postgres `bigint` column. The
 * band index is folded in so equal rows in different bands never collide.
 */
export const lshBandKeys = (signature: Uint32Array): bigint[] =>
  Array.from({ length: LSH_BANDS }, (_, band) =>
    BigInt.asIntN(
      64,
      (bandHash(signature, band, 0x9e_37_79_b9) << 32n) |
        bandHash(signature, band, 0x85_eb_ca_6b),
    ),
  );
