import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import {
  zstdCompressAsync,
  zstdDecompressToStringBounded,
} from "@/api/lib/compression";
import type { PackedCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import { LIMITS } from "@/api/lib/limits";
import { putCorpusS3ObjectWithSignal } from "@/api/lib/s3";
import { withTimeout } from "@/api/lib/with-timeout";

/**
 * Corpus pack format.
 *
 * A pack is one immutable object that concatenates corpus payloads, each
 * addressed by byte range (see corpus-location.ts). Layout:
 *
 *   member₀ bytes | member₁ bytes | … | footer | footer length | magic
 *
 * Each member is exactly the bytes of the standalone object it stands for
 * (the zstd frame), so a range read of a member decompresses through the
 * same path as an object read. The footer is zstd-compressed JSON
 * `{ version: 1, members: [{ offset, length, kind, documentId, contentHash,
 * sha256 }] }`, followed by its own byte length as an 8-byte little-endian
 * integer and the 8-byte magic `STLPACK1`. A reader that holds an address
 * never needs the footer; the footer lists the members for a reader that
 * holds only the pack.
 */

export const PACK_MAGIC = "STLPACK1";
const PACK_MAGIC_BYTES = new TextEncoder().encode(PACK_MAGIC);
const MAGIC_LENGTH = PACK_MAGIC_BYTES.byteLength;
const FOOTER_LENGTH_FIELD_BYTES = 8;
const TRAILER_LENGTH = FOOTER_LENGTH_FIELD_BYTES + MAGIC_LENGTH;
export const PACK_FORMAT_VERSION = 1;
const PACK_CONTENT_TYPE = "application/octet-stream";

// Ceiling on the decoded footer, so a corrupt length field cannot ask for
// an unbounded decode.
const FOOTER_MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

const PACK_MEMBER_KINDS = ["text", "sections", "ast"] as const;
export type PackMemberKind = (typeof PACK_MEMBER_KINDS)[number];

export class CorpusPackError extends TaggedError("CorpusPackError")<{
  message: string;
  cause?: unknown;
}> {}

const packMemberSchema = v.object({
  offset: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  length: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
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

type PackKeyInput = { jurisdiction: string; packId: string };

/** Pack ids are UUIDv7. */
export const newCorpusPackId = (): string => Bun.randomUUIDv7();

export const packKey = ({ jurisdiction, packId }: PackKeyInput): string =>
  `legal-corpus/packs/jurisdiction=${jurisdiction}/${packId}.pack`;

const sha256Hex = (bytes: Uint8Array): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
};

type EncodePackInput = { packKey: string; members: PackMemberInput[] };

type EncodedPack = { bytes: Uint8Array; entries: PackedEntry[] };

export const encodePack = async ({
  packKey: key,
  members,
}: EncodePackInput): Promise<EncodedPack> => {
  if (members.length === 0) {
    return panic("A corpus pack must carry at least one member");
  }
  const entries: PackedEntry[] = [];
  let offset = 0;
  for (const { kind, documentId, contentHash, bytes } of members) {
    const member = {
      offset,
      length: bytes.byteLength,
      kind,
      documentId,
      contentHash,
      sha256: sha256Hex(bytes),
    };
    entries.push({
      member,
      location: {
        type: "packed",
        packKey: key,
        offset,
        length: bytes.byteLength,
      },
    });
    offset += bytes.byteLength;
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
  return { bytes, entries };
};

const magicMatches = (bytes: Uint8Array): boolean =>
  bytes.byteLength >= MAGIC_LENGTH &&
  PACK_MAGIC_BYTES.every(
    (byte, index) => bytes[bytes.byteLength - MAGIC_LENGTH + index] === byte,
  );

/**
 * Decode a whole pack's footer, refusing anything that does not read as a
 * version-1 pack: wrong magic, a footer length that does not fit inside the
 * object, or a member that points outside the payload region.
 */
export const decodePackFooter = async (
  bytes: Uint8Array,
): Promise<PackFooter> => {
  if (!magicMatches(bytes)) {
    throw new CorpusPackError({
      message: "Corpus pack does not end with the pack magic",
    });
  }
  const lengthField = new DataView(
    bytes.buffer,
    bytes.byteOffset + bytes.byteLength - TRAILER_LENGTH,
    FOOTER_LENGTH_FIELD_BYTES,
  ).getBigUint64(0, true);
  const payloadEnd = bytes.byteLength - TRAILER_LENGTH;
  if (lengthField === 0n || lengthField > BigInt(payloadEnd)) {
    throw new CorpusPackError({
      message: `Corpus pack footer length ${lengthField} does not fit a ${bytes.byteLength}-byte pack`,
    });
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
    throw decoded.error;
  }
  const footer = v.safeParse(packFooterSchema, decoded.value);
  if (!footer.success) {
    throw new CorpusPackError({
      message: `Corpus pack footer is malformed: ${footer.issues.map((issue) => issue.message).join("; ")}`,
    });
  }
  for (const member of footer.output.members) {
    if (member.offset + member.length > footerStart) {
      throw new CorpusPackError({
        message: `Corpus pack member at ${member.offset}+${member.length} lies outside the payload region`,
      });
    }
  }
  return footer.output;
};

type WriteCorpusPackInput = {
  jurisdiction: string;
  packId: string;
  members: PackMemberInput[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Test seam; production always PUTs through the corpus bucket client. */
  put?: (key: string, bytes: Uint8Array, signal: AbortSignal) => Promise<void>;
};

type WriteCorpusPackResult = { packKey: string; entries: PackedEntry[] };

const putPack = async (
  key: string,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<void> =>
  await putCorpusS3ObjectWithSignal(key, bytes, PACK_CONTENT_TYPE, signal);

/** Encode the members and PUT the pack once under its derived key. */
export const writeCorpusPack = async ({
  jurisdiction,
  packId,
  members,
  signal,
  timeoutMs = LIMITS.corpusObjectIoTimeoutMs,
  put = putPack,
}: WriteCorpusPackInput): Promise<WriteCorpusPackResult> => {
  const key = packKey({ jurisdiction, packId });
  const { bytes, entries } = await encodePack({ packKey: key, members });
  await withTimeout(async (writeSignal) => await put(key, bytes, writeSignal), {
    label: "corpus-write-pack",
    signal,
    timeoutMs,
  });
  return { packKey: key, entries };
};
