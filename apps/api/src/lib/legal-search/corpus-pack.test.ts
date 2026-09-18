import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { zstdCompress, zstdDecompressToString } from "@/api/lib/compression";
import { CorpusMemberDigestMismatchError } from "@/api/lib/errors/tagged-errors";
import { formatCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import {
  CorpusPackError,
  decodePackFooter,
  encodePack,
  packJurisdictionPrefix,
  packKeyForMembers,
  PACK_FORMAT_VERSION,
  PACK_MAGIC,
  corpusMemberDigest,
} from "@/api/lib/legal-search/corpus-pack";
import type {
  PackFooter,
  PackFooterMember,
  PackMemberKind,
  PackMemberInput,
} from "@/api/lib/legal-search/corpus-pack";
import {
  CORPUS_TRANSFER_MAX_BYTES,
  readCorpusBytesAt,
} from "@/api/lib/legal-search/corpus-storage";

const JURISDICTION = "SVK";
const DOCUMENT_ID = "0d2f4a5e-9c1b-4c62-8b1a-3f6f2f8f9e10";
const CONTENT_HASH = "a".repeat(64);

const payloads = {
  text: "Rozsudok v mene Slovenskej republiky.",
  sections: JSON.stringify([
    { index: 0, type: "header", title: null, text: "Rozsudok" },
  ]),
  ast: JSON.stringify(null),
} as const;

/** Each fixture pairs the member as written with what its bytes decode to. */
const fixtures = [
  { kind: "text", decodes: payloads.text },
  { kind: "sections", decodes: payloads.sections },
  { kind: "ast", decodes: payloads.ast },
] as const satisfies readonly {
  kind: PackMemberInput["kind"];
  decodes: string;
}[];

const members: PackMemberInput[] = fixtures.map(({ kind, decodes }) => ({
  kind,
  documentId: DOCUMENT_ID,
  contentHash: CONTENT_HASH,
  bytes: zstdCompress(decodes),
}));

const trailerOf = (bytes: Uint8Array) => ({
  magic: new TextDecoder().decode(bytes.subarray(bytes.byteLength - 8)),
  footerLength: new DataView(
    bytes.buffer,
    bytes.byteOffset + bytes.byteLength - 16,
    8,
  ).getBigUint64(0, true),
});

/** A pack laid out by hand, so a test can write a footer the encoder never would. */
const packAround = (
  footerValue: unknown,
  payload: Uint8Array = new Uint8Array(),
): Uint8Array => {
  const footer = zstdCompress(JSON.stringify(footerValue));
  const bytes = new Uint8Array(payload.byteLength + footer.byteLength + 16);
  bytes.set(payload, 0);
  bytes.set(footer, payload.byteLength);
  new DataView(
    bytes.buffer,
    payload.byteLength + footer.byteLength,
    8,
  ).setBigUint64(0, BigInt(footer.byteLength), true);
  bytes.set(
    new TextEncoder().encode(PACK_MAGIC),
    payload.byteLength + footer.byteLength + 8,
  );
  return bytes;
};

const noTombstones = async (): Promise<ReadonlySet<string>> =>
  await Promise.resolve(new Set<string>());

const rangeOver =
  (pack: Uint8Array) =>
  async ({
    offset,
    length,
  }: {
    key: string;
    offset: number;
    length: number;
  }): Promise<Uint8Array> =>
    await Promise.resolve(pack.subarray(offset, offset + length));

/** A footer that does not decode fails the test, not a case in it. */
const unwrapFooter = (
  decoded: Awaited<ReturnType<typeof decodePackFooter>>,
): PackFooter => {
  if (Result.isError(decoded)) {
    throw decoded.error;
  }
  return decoded.value;
};

const readMember = async (
  pack: Uint8Array,
  member: PackFooterMember,
  packKey: string,
): Promise<Uint8Array> =>
  await readCorpusBytesAt({
    location: {
      type: "packed",
      packKey,
      offset: member.offset,
      length: member.length,
      sha256: member.sha256,
    },
    maxBytes: CORPUS_TRANSFER_MAX_BYTES,
    signal: new AbortController().signal,
    readObject: async () =>
      await Promise.reject(new Error("object read must not run")),
    readRange: rangeOver(pack),
    readTombstones: noTombstones,
  });

describe("corpus pack round-trip", () => {
  test("each member's range slice is the standalone object's bytes", async () => {
    const { packKey, bytes, entries } = await encodePack({
      jurisdiction: JURISDICTION,
      members,
    });

    expect(entries).toHaveLength(members.length);
    for (const [index, entry] of entries.entries()) {
      const input = members[index];
      const fixture = fixtures[index];
      if (input === undefined || fixture === undefined) {
        throw new Error("member index out of range");
      }
      const { offset, length } = entry.location;
      const slice = bytes.subarray(offset, offset + length);
      expect(entry.location.packKey).toBe(packKey);
      expect(entry.member).toEqual({
        offset,
        length,
        kind: input.kind,
        documentId: input.documentId,
        contentHash: input.contentHash,
        sha256: corpusMemberDigest(input.bytes),
      });
      expect([...slice]).toEqual([...input.bytes]);
      expect(zstdDecompressToString(slice)).toBe(fixture.decodes);
    }
    // Members are laid out contiguously from byte zero.
    const expectedOffsets: number[] = [];
    let cursor = 0;
    for (const { bytes: memberBytes } of members) {
      expectedOffsets.push(cursor);
      cursor += memberBytes.byteLength;
    }
    expect(entries.map(({ location }) => location.offset)).toEqual(
      expectedOffsets,
    );
  });

  test("the footer decodes to the entries the encoder reported", async () => {
    const { bytes, entries } = await encodePack({
      jurisdiction: JURISDICTION,
      members,
    });

    const { magic, footerLength } = trailerOf(bytes);
    expect(magic).toBe(PACK_MAGIC);
    expect(footerLength).toBeGreaterThan(0n);

    const footer = unwrapFooter(await decodePackFooter(bytes));
    expect(footer.version).toBe(PACK_FORMAT_VERSION);
    expect(footer.members).toEqual(entries.map(({ member }) => member));
  });

  test("an address formatted from an entry names the member's range", async () => {
    const { packKey, entries } = await encodePack({
      jurisdiction: JURISDICTION,
      members,
    });
    const first = entries.at(0);
    if (first === undefined) {
      throw new Error("pack has no entries");
    }

    expect(formatCorpusLocation(first.location)).toBe(
      `pack:${packKey}@0+${first.member.length}#${first.member.sha256}`,
    );
  });

  test("a member whose stored bytes drifted from the footer digest is refused on read", async () => {
    const { packKey, bytes } = await encodePack({
      jurisdiction: JURISDICTION,
      members,
    });
    const footer = unwrapFooter(await decodePackFooter(bytes));
    const member = footer.members.at(0);
    if (member === undefined) {
      throw new Error("pack has no members");
    }
    const corrupt = bytes.slice();
    const flipped = corrupt[member.offset];
    if (flipped === undefined) {
      throw new Error("member offset outside the pack");
    }
    // A different byte, whatever the original was: the digest check is
    // what has to notice, not the arithmetic that produced it.
    corrupt[member.offset] = flipped === 0 ? 1 : 0;
    // The fault must reach the check: the byte really changed, and the
    // range still returns the declared length, so only the digest can tell.
    expect(
      corpusMemberDigest(
        corrupt.subarray(member.offset, member.offset + member.length),
      ),
    ).not.toBe(member.sha256);

    const rejection: unknown = await readMember(corrupt, member, packKey).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(CorpusMemberDigestMismatchError);
    expect(rejection).toMatchObject({
      digest: corpusMemberDigest(
        corrupt.subarray(member.offset, member.offset + member.length),
      ),
      location: `pack:${packKey}@${member.offset}+${member.length}#${member.sha256}`,
    });
  });

  test("an empty member list is refused", async () => {
    let captured: unknown;
    try {
      await encodePack({ jurisdiction: JURISDICTION, members: [] });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
  });

  test("a zero-byte member is refused before any entry is generated", async () => {
    // A zero-length range has no address a range read can express, so an
    // encoder that accepted it would hand out an unreadable location.
    const first = members.at(0);
    if (first === undefined) {
      throw new Error("fixture has no members");
    }
    const captured: unknown = await encodePack({
      jurisdiction: JURISDICTION,
      members: [first, { ...first, kind: "ast", bytes: new Uint8Array() }],
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(captured).toBeInstanceOf(Error);
    expect(captured).toMatchObject({
      message: expect.stringContaining("carries no bytes"),
    });
  });
});

describe("content-addressed pack keys", () => {
  test("the same members encode to the same key and the same bytes", async () => {
    const first = await encodePack({ jurisdiction: JURISDICTION, members });
    const second = await encodePack({ jurisdiction: JURISDICTION, members });

    expect(second.packKey).toBe(first.packKey);
    expect([...second.bytes]).toEqual([...first.bytes]);
    expect(second.entries).toEqual(first.entries);
  });

  test("a changed member moves the pack to a different key", async () => {
    const { packKey } = await encodePack({
      jurisdiction: JURISDICTION,
      members,
    });
    const [text, ...rest] = members;
    if (text === undefined) {
      throw new Error("fixture has no members");
    }
    const { packKey: changed } = await encodePack({
      jurisdiction: JURISDICTION,
      members: [
        { ...text, bytes: zstdCompress(`${payloads.text} Dodatok.`) },
        ...rest,
      ],
    });

    expect(changed).not.toBe(packKey);
  });

  test("a jurisdiction's packs land under its partition", async () => {
    const svk = await encodePack({ jurisdiction: "SVK", members });
    const cze = await encodePack({ jurisdiction: "CZE", members });

    expect(svk.packKey.startsWith(packJurisdictionPrefix("SVK"))).toBe(true);
    expect(cze.packKey.startsWith(packJurisdictionPrefix("CZE"))).toBe(true);
    // Same members, different partition: the key cannot be shared across
    // jurisdictions, or a partition prefix would stop answering which
    // jurisdiction a stored address belongs to.
    expect(cze.packKey).not.toBe(svk.packKey);
  });

  test("a key needs at least one member", () => {
    expect(() =>
      packKeyForMembers({ jurisdiction: JURISDICTION, members: [] }),
    ).toThrow("at least one member");
  });
});

describe("decodePackFooter refuses malformed packs", () => {
  const rejection = async (bytes: Uint8Array): Promise<unknown> => {
    const decoded = await decodePackFooter(bytes);
    return Result.isError(decoded) ? decoded.error : null;
  };

  test("wrong magic", async () => {
    const { bytes } = await encodePack({
      jurisdiction: JURISDICTION,
      members,
    });
    const corrupt = bytes.slice();
    corrupt.set(new TextEncoder().encode("NOTAPACK"), corrupt.byteLength - 8);

    const error = await rejection(corrupt);
    expect(error).toBeInstanceOf(CorpusPackError);
    expect(error).toMatchObject({ message: expect.stringContaining("magic") });
  });

  test("a footer length that does not fit the object", async () => {
    const { bytes } = await encodePack({
      jurisdiction: JURISDICTION,
      members,
    });
    const corrupt = bytes.slice();
    new DataView(
      corrupt.buffer,
      corrupt.byteOffset + corrupt.byteLength - 16,
      8,
    ).setBigUint64(0, BigInt(corrupt.byteLength), true);

    const error = await rejection(corrupt);
    expect(error).toBeInstanceOf(CorpusPackError);
    expect(error).toMatchObject({
      message: expect.stringContaining("footer length"),
    });
  });

  test("a zero footer length", async () => {
    const { bytes } = await encodePack({
      jurisdiction: JURISDICTION,
      members,
    });
    const corrupt = bytes.slice();
    new DataView(
      corrupt.buffer,
      corrupt.byteOffset + corrupt.byteLength - 16,
      8,
    ).setBigUint64(0, 0n, true);

    expect(await rejection(corrupt)).toBeInstanceOf(CorpusPackError);
  });

  test("an unsupported footer version", async () => {
    const error = await rejection(
      packAround({ version: PACK_FORMAT_VERSION + 1, members: [] }),
    );
    expect(error).toBeInstanceOf(CorpusPackError);
    expect(error).toMatchObject({
      message: expect.stringContaining("malformed"),
    });
  });

  test("a footer that is not zstd-compressed JSON", async () => {
    const footer = new TextEncoder().encode("not zstd");
    const bytes = new Uint8Array(footer.byteLength + 16);
    bytes.set(footer, 0);
    new DataView(bytes.buffer, footer.byteLength, 8).setBigUint64(
      0,
      BigInt(footer.byteLength),
      true,
    );
    bytes.set(new TextEncoder().encode(PACK_MAGIC), footer.byteLength + 8);

    expect(await rejection(bytes)).toBeInstanceOf(CorpusPackError);
  });

  test("a member that points outside the payload region", async () => {
    // No payload bytes at all, so a member of length 1 cannot fit.
    const error = await rejection(
      packAround({
        version: PACK_FORMAT_VERSION,
        members: [
          {
            offset: 0,
            length: 1,
            kind: "text",
            documentId: "d",
            contentHash: "h",
            sha256: "0".repeat(64),
          },
        ],
      }),
    );
    expect(error).toBeInstanceOf(CorpusPackError);
    expect(error).toMatchObject({
      message: expect.stringContaining("outside the payload region"),
    });
  });

  test("a buffer shorter than the trailer", async () => {
    expect(await rejection(new Uint8Array(3))).toBeInstanceOf(CorpusPackError);
  });

  test("a buffer shorter than the trailer that still ends with the magic", async () => {
    // 8 to 15 bytes: long enough to carry the magic, too short for the
    // footer length field in front of it. Every length in the window must
    // fail with the decoder's error, not a raw buffer-range error.
    const magic = new TextEncoder().encode(PACK_MAGIC);
    const window = Array.from(
      { length: 16 - magic.byteLength },
      (_, index) => magic.byteLength + index,
    );
    const errors = await Promise.all(
      window.map(async (length) => {
        const bytes = new Uint8Array(length);
        bytes.set(magic, length - magic.byteLength);
        return await rejection(bytes);
      }),
    );

    expect(errors).toHaveLength(8);
    for (const error of errors) {
      expect(error).toBeInstanceOf(CorpusPackError);
      expect(error).toMatchObject({
        message: expect.stringContaining("shorter than"),
      });
    }
  });

  test("a footer member of zero length", async () => {
    const error = await rejection(
      packAround({
        version: PACK_FORMAT_VERSION,
        members: [
          {
            offset: 0,
            length: 0,
            kind: "text",
            documentId: "d",
            contentHash: "h",
            sha256: "0".repeat(64),
          },
        ],
      }),
    );
    expect(error).toBeInstanceOf(CorpusPackError);
    expect(error).toMatchObject({
      message: expect.stringContaining("malformed"),
    });
  });
});

describe("pack identity names one layout and one owner set", () => {
  const memberOf = (
    documentId: string,
    kind: PackMemberKind,
    text: string,
  ) => ({
    documentId,
    kind,
    contentHash: "c".repeat(64),
    bytes: new TextEncoder().encode(text),
  });

  test("the same members in a different order land at the same addresses", async () => {
    const one = memberOf("doc-a", "text", "Rozsudok A.");
    const two = memberOf("doc-b", "text", "Rozsudok B.");
    const three = memberOf("doc-b", "sections", "[]");

    const forward = await encodePack({
      jurisdiction: "SVK",
      members: [one, two, three],
    });
    const shuffled = await encodePack({
      jurisdiction: "SVK",
      members: [three, one, two],
    });

    // A retried page enqueues its decisions in whatever order it processes
    // them; the addresses it settles must not depend on that, or the retry
    // points rows at ranges the object under that key does not hold.
    expect(shuffled.packKey).toBe(forward.packKey);
    expect(shuffled.entries.map(({ location }) => location)).toEqual(
      forward.entries.map(({ location }) => location),
    );
    expect(shuffled.bytes).toEqual(forward.bytes);
  });

  test("two documents with identical payloads never share an address", async () => {
    const payload = "Rozsudok v mene Slovenskej republiky.";
    const first = await encodePack({
      jurisdiction: "SVK",
      members: [memberOf("doc-a", "text", payload)],
    });
    const second = await encodePack({
      jurisdiction: "SVK",
      members: [memberOf("doc-b", "text", payload)],
    });

    // Byte-identical payloads are common (an empty section list, a short
    // ruling). If they shared a key and an offset, erasing one document
    // would deny the other document's reads.
    expect(second.packKey).not.toBe(first.packKey);
    expect(second.entries.at(0)?.location).not.toEqual(
      first.entries.at(0)?.location,
    );
  });
});
