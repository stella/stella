import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import {
  zstdCompressAsync,
  zstdDecompressToStringBounded,
} from "@/api/lib/compression";
import type { PackedCorpusLocation } from "@/api/lib/legal-search/corpus-location";

/**
 * Corpus pack format.
 *
 * A pack is one immutable object that concatenates corpus payloads, each
 * addressed by byte range (see corpus-location.ts). Layout:
 *
 *   member₀ bytes | member₁ bytes | … | footer | footer length | magic
 *
 * Each member is exactly the bytes of the standalone object it stands for,
 * so a range read of a member decompresses through the same path as an
 * object read. The footer is zstd-compressed JSON
 * `{ version: 1, members: [{ offset, length, kind, documentId, contentHash,
 * sha256, encoding }] }`, followed by its own byte length as an 8-byte
 * little-endian integer and the 8-byte magic `STLPACK1`. A reader that holds
 * an address never needs the footer; the footer lists the members for a
 * reader that holds only the pack.
 *
 * The pack's key is derived from its members' ordered identities
 * ({@link packKeyForMembers}): which document each member belongs to, which
 * payload it is, its digest and its length, in layout order. Two encodings of
 * the same members therefore name the same object with the same offsets, and
 * a batch retried after an ambiguous PUT re-derives exactly the addresses it
 * settled. Nothing else may share that key: a key that named only the bytes
 * would give two documents with identical payloads one address, and erasing
 * one of them would deny the other.
 */

export const PACK_MAGIC = "STLPACK1";
const PACK_MAGIC_BYTES = new TextEncoder().encode(PACK_MAGIC);
const MAGIC_LENGTH = PACK_MAGIC_BYTES.byteLength;
const FOOTER_LENGTH_FIELD_BYTES = 8;
const TRAILER_LENGTH = FOOTER_LENGTH_FIELD_BYTES + MAGIC_LENGTH;
export const PACK_FORMAT_VERSION = 1;
export const PACK_CONTENT_TYPE = "application/octet-stream";

// Ceiling on the decoded footer, so a corrupt length field cannot ask for
// an unbounded decode.
const FOOTER_MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

export const PACK_MEMBER_KINDS = ["text", "sections", "ast"] as const;
export type PackMemberKind = (typeof PACK_MEMBER_KINDS)[number];

export class CorpusPackError extends TaggedError("CorpusPackError")<{
  message: string;
  cause?: unknown;
}> {}

const packMemberSchema = v.object({
  offset: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  // A member never carries zero bytes; see encodePack.
  length: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  kind: v.picklist(PACK_MEMBER_KINDS),
  documentId: v.string(),
  contentHash: v.string(),
  sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
});

// Unknown keys are ignored: the version field, not the key set, decides
// what a footer means.
const packFooterSchema = v.object({
  version: v.literal(PACK_FORMAT_VERSION),
  members: v.array(packMemberSchema),
});

export type PackFooterMember = v.InferOutput<typeof packMemberSchema>;
export type PackFooter = v.InferOutput<typeof packFooterSchema>;

export type PackMemberInput = {
  kind: PackMemberKind;
  documentId: string;
  contentHash: string;
  /** The standalone object's bytes: the zstd frame, unchanged. */
  bytes: Uint8Array;
};

export type PackedEntry = {
  member: PackFooterMember;
  location: PackedCorpusLocation;
};

const PACK_EXTENSION = ".stlpack";

export const corpusMemberDigest = (bytes: Uint8Array): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
};

/** What the key commits to, per member, in layout order. */
type PackMemberIdentity = {
  documentId: string;
  kind: PackMemberKind;
  sha256: string;
  length: number;
};

type PackKeyInput = {
  jurisdiction: string;
  /** The members as they are laid out, in that order. */
  members: readonly PackMemberIdentity[];
};

/**
 * The key a pack of exactly these members, in exactly this layout, lands at.
 *
 * The digest covers each member's owner, kind, bytes and length in layout
 * order, so the key names one object with one set of offsets. A key over the
 * bytes alone would not: the same batch laid out differently would collide
 * under it while carrying different offsets, and two documents whose payloads
 * happen to be identical would share an address, which makes one document's
 * erasure the other document's outage.
 */
export const packKeyForMembers = ({
  jurisdiction,
  members,
}: PackKeyInput): string => {
  if (members.length === 0) {
    return panic("A corpus pack key needs at least one member");
  }
  const hasher = new Bun.CryptoHasher("sha256");
  for (const { documentId, kind, sha256, length } of members) {
    hasher.update(
      `${documentId}\u0000${kind}\u0000${sha256}\u0000${length}\u0000`,
    );
  }
  return `${packJurisdictionPrefix(jurisdiction)}${hasher.digest("hex")}${PACK_EXTENSION}`;
};

/**
 * The order a pack lays its members out in, whatever order the batch
 * collected them: by document, then by payload kind. A page retried after a
 * failure enqueues its decisions in whatever order it reprocesses them, and
 * the addresses it settles must not depend on that.
 */
const MEMBER_KIND_ORDER: Record<PackMemberKind, number> = {
  text: 0,
  sections: 1,
  ast: 2,
};

const inLayoutOrder = (
  members: readonly PackMemberInput[],
): PackMemberInput[] =>
  [...members].toSorted((left, right) => {
    if (left.documentId !== right.documentId) {
      // Document ids, not words: the layout must be the same wherever this
      // runs, which a locale-aware comparison would not guarantee.
      return left.documentId < right.documentId ? -1 : 1;
    }
    return MEMBER_KIND_ORDER[left.kind] - MEMBER_KIND_ORDER[right.kind];
  });

/**
 * The partition every pack of one jurisdiction lands under. A reader asking
 * whether a stored address belongs to a jurisdiction asks this, so the
 * question is answered by the key derivation rather than beside it.
 */
export const packJurisdictionPrefix = (jurisdiction: string): string =>
  `legal-corpus/packs/jurisdiction=${jurisdiction}/`;

type EncodePackInput = { jurisdiction: string; members: PackMemberInput[] };

export type EncodedPack = {
  packKey: string;
  bytes: Uint8Array;
  entries: PackedEntry[];
};

export const encodePack = async ({
  jurisdiction,
  members: collected,
}: EncodePackInput): Promise<EncodedPack> => {
  if (collected.length === 0) {
    return panic("A corpus pack must carry at least one member");
  }
  const members = inLayoutOrder(collected);
  for (const { kind, documentId, bytes } of members) {
    // A zero-length range has no address a range read can express, so an
    // empty member is refused before any entry is generated for it.
    if (bytes.byteLength === 0) {
      return panic(
        `Corpus pack member ${kind} for ${documentId} carries no bytes`,
      );
    }
  }
  const digests = members.map(({ bytes }) => corpusMemberDigest(bytes));
  const key = packKeyForMembers({
    jurisdiction,
    members: members.map((member, index) => ({
      documentId: member.documentId,
      kind: member.kind,
      sha256: digests[index] ?? panic("Member digest lost"),
      length: member.bytes.byteLength,
    })),
  });

  const entries: PackedEntry[] = [];
  let offset = 0;
  for (const [index, member] of members.entries()) {
    const sha256 = digests[index] ?? panic("Member digest lost");
    const length = member.bytes.byteLength;
    entries.push({
      member: {
        offset,
        length,
        kind: member.kind,
        documentId: member.documentId,
        contentHash: member.contentHash,
        sha256,
      },
      location: {
        type: "packed",
        packKey: key,
        offset,
        length,
        sha256,
      },
    });
    offset += length;
  }
  const footer = await zstdCompressAsync(
    JSON.stringify({
      version: PACK_FORMAT_VERSION,
      members: entries.map(({ member }) => member),
    } satisfies PackFooter),
  );

  const bytes = new Uint8Array(offset + footer.byteLength + TRAILER_LENGTH);
  let cursor = 0;
  for (const { bytes: memberBytes } of members) {
    bytes.set(memberBytes, cursor);
    cursor += memberBytes.byteLength;
  }
  bytes.set(footer, cursor);
  cursor += footer.byteLength;
  new DataView(bytes.buffer, bytes.byteOffset + cursor).setBigUint64(
    0,
    BigInt(footer.byteLength),
    true,
  );
  cursor += FOOTER_LENGTH_FIELD_BYTES;
  bytes.set(PACK_MAGIC_BYTES, cursor);
  return { packKey: key, bytes, entries };
};

const magicMatches = (bytes: Uint8Array): boolean =>
  PACK_MAGIC_BYTES.every(
    (byte, index) => bytes[bytes.byteLength - MAGIC_LENGTH + index] === byte,
  );

/**
 * Decode a whole pack's footer, refusing anything that does not read as a
 * version-1 pack: an object shorter than the trailer, wrong magic, a footer
 * length that does not fit inside the object, or a member that points
 * outside the payload region. Every refusal is a {@link CorpusPackError} the
 * caller receives rather than catches: a pack that does not decode is an
 * answer about that object, not a failure of the process reading it.
 */
export const decodePackFooter = async (
  bytes: Uint8Array,
): Promise<Result<PackFooter, CorpusPackError>> => {
  // The trailer (footer length + magic) is read as a whole; checking the
  // full length first keeps the magic and length reads inside the buffer.
  if (bytes.byteLength < TRAILER_LENGTH) {
    return Result.err(
      new CorpusPackError({
        message: `Corpus pack of ${bytes.byteLength} bytes is shorter than the ${TRAILER_LENGTH}-byte trailer`,
      }),
    );
  }
  if (!magicMatches(bytes)) {
    return Result.err(
      new CorpusPackError({
        message: "Corpus pack does not end with the pack magic",
      }),
    );
  }
  const lengthField = new DataView(
    bytes.buffer,
    bytes.byteOffset + bytes.byteLength - TRAILER_LENGTH,
    FOOTER_LENGTH_FIELD_BYTES,
  ).getBigUint64(0, true);
  const payloadEnd = bytes.byteLength - TRAILER_LENGTH;
  if (lengthField === 0n || lengthField > BigInt(payloadEnd)) {
    return Result.err(
      new CorpusPackError({
        message: `Corpus pack footer length ${lengthField} does not fit a ${bytes.byteLength}-byte pack`,
      }),
    );
  }
  const footerLength = Number(lengthField);
  const footerStart = payloadEnd - footerLength;
  const decoded = await Result.tryPromise({
    try: async (): Promise<unknown> =>
      JSON.parse(
        await zstdDecompressToStringBounded(
          bytes.subarray(footerStart, payloadEnd),
          FOOTER_MAX_DECOMPRESSED_BYTES,
        ),
      ),
    catch: (cause) =>
      new CorpusPackError({
        message: "Corpus pack footer does not decode as zstd-compressed JSON",
        cause,
      }),
  });
  if (Result.isError(decoded)) {
    return decoded;
  }
  const footer = v.safeParse(packFooterSchema, decoded.value);
  if (!footer.success) {
    return Result.err(
      new CorpusPackError({
        message: `Corpus pack footer is malformed: ${footer.issues.map((issue) => issue.message).join("; ")}`,
      }),
    );
  }
  for (const member of footer.output.members) {
    if (member.offset + member.length > footerStart) {
      return Result.err(
        new CorpusPackError({
          message: `Corpus pack member at ${member.offset}+${member.length} lies outside the payload region`,
        }),
      );
    }
  }
  return Result.ok(footer.output);
};
