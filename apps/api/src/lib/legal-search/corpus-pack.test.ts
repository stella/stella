import { describe, expect, test } from "bun:test";

import { zstdCompress, zstdDecompressToString } from "@/api/lib/compression";
import { formatCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import {
  CorpusPackError,
  decodePackFooter,
  encodePack,
  newCorpusPackId,
  PACK_FORMAT_VERSION,
  PACK_MAGIC,
  packKey,
  writeCorpusPack,
} from "@/api/lib/legal-search/corpus-pack";
import type { PackMemberInput } from "@/api/lib/legal-search/corpus-pack";

const sha256 = (bytes: Uint8Array): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
};

const PACK_KEY = packKey({
  jurisdiction: "SVK",
  packId: "01912f6a-4b0c-7d3e-9a1b-2c3d4e5f6a7b",
});

const payloads = {
  text: "Rozsudok v mene Slovenskej republiky.",
  sections: JSON.stringify([
    { index: 0, type: "header", title: null, text: "Rozsudok" },
  ]),
  ast: JSON.stringify(null),
} as const;

const members: PackMemberInput[] = [
  {
    kind: "text",
    documentId: "0d2f4a5e-9c1b-4c62-8b1a-3f6f2f8f9e10",
    contentHash: "a".repeat(64),
    bytes: zstdCompress(payloads.text),
  },
  {
    kind: "sections",
    documentId: "0d2f4a5e-9c1b-4c62-8b1a-3f6f2f8f9e10",
    contentHash: "a".repeat(64),
    bytes: zstdCompress(payloads.sections),
  },
  {
    kind: "ast",
    documentId: "0d2f4a5e-9c1b-4c62-8b1a-3f6f2f8f9e10",
    contentHash: "a".repeat(64),
    bytes: zstdCompress(payloads.ast),
  },
];

const trailerOf = (bytes: Uint8Array) => ({
  magic: new TextDecoder().decode(bytes.subarray(bytes.byteLength - 8)),
  footerLength: new DataView(
    bytes.buffer,
    bytes.byteOffset + bytes.byteLength - 16,
    8,
  ).getBigUint64(0, true),
});

describe("corpus pack round-trip", () => {
  test("each member's range slice is the standalone object's bytes", async () => {
    const { bytes, entries } = await encodePack({
      packKey: PACK_KEY,
      members,
    });

    expect(entries).toHaveLength(members.length);
    for (const [index, entry] of entries.entries()) {
      const input = members[index];
      if (input === undefined) {
        throw new Error("member index out of range");
      }
      const { offset, length } = entry.location;
      const slice = bytes.subarray(offset, offset + length);
      expect(entry.location.packKey).toBe(PACK_KEY);
      expect(entry.member).toEqual({
        offset,
        length,
        kind: input.kind,
        documentId: input.documentId,
        contentHash: input.contentHash,
        sha256: sha256(input.bytes),
      });
      expect([...slice]).toEqual([...input.bytes]);
      expect(zstdDecompressToString(slice)).toBe(payloads[input.kind]);
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
      packKey: PACK_KEY,
      members,
    });

    const { magic, footerLength } = trailerOf(bytes);
    expect(magic).toBe(PACK_MAGIC);
    expect(footerLength).toBeGreaterThan(0n);

    const footer = await decodePackFooter(bytes);
    expect(footer.version).toBe(PACK_FORMAT_VERSION);
    expect(footer.members).toEqual(entries.map(({ member }) => member));
  });

  test("an address formatted from an entry names the member's range", async () => {
    const { entries } = await encodePack({ packKey: PACK_KEY, members });
    const first = entries.at(0);
    if (first === undefined) {
      throw new Error("pack has no entries");
    }

    expect(formatCorpusLocation(first.location)).toBe(
      `pack:${PACK_KEY}@0+${first.member.length}`,
    );
  });

  test("an empty member list is refused", async () => {
    let captured: unknown;
    try {
      await encodePack({ packKey: PACK_KEY, members: [] });
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
      packKey: PACK_KEY,
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

describe("decodePackFooter refuses malformed packs", () => {
  const rejection = async (bytes: Uint8Array): Promise<unknown> =>
    await decodePackFooter(bytes).then(
      () => null,
      (error: unknown) => error,
    );

  test("wrong magic", async () => {
    const { bytes } = await encodePack({ packKey: PACK_KEY, members });
    const corrupt = bytes.slice();
    corrupt.set(new TextEncoder().encode("NOTAPACK"), corrupt.byteLength - 8);

    const error = await rejection(corrupt);
    expect(error).toBeInstanceOf(CorpusPackError);
    expect(error).toMatchObject({ message: expect.stringContaining("magic") });
  });

  test("a footer length that does not fit the object", async () => {
    const { bytes } = await encodePack({ packKey: PACK_KEY, members });
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
    const { bytes } = await encodePack({ packKey: PACK_KEY, members });
    const corrupt = bytes.slice();
    new DataView(
      corrupt.buffer,
      corrupt.byteOffset + corrupt.byteLength - 16,
      8,
    ).setBigUint64(0, 0n, true);

    expect(await rejection(corrupt)).toBeInstanceOf(CorpusPackError);
  });

  test("an unsupported footer version", async () => {
    const footer = zstdCompress(
      JSON.stringify({ version: PACK_FORMAT_VERSION + 1, members: [] }),
    );
    const bytes = new Uint8Array(footer.byteLength + 16);
    bytes.set(footer, 0);
    new DataView(bytes.buffer, footer.byteLength, 8).setBigUint64(
      0,
      BigInt(footer.byteLength),
      true,
    );
    bytes.set(new TextEncoder().encode(PACK_MAGIC), footer.byteLength + 8);

    const error = await rejection(bytes);
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
    const footer = zstdCompress(
      JSON.stringify({
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
    // No payload bytes at all, so a member of length 1 cannot fit.
    const bytes = new Uint8Array(footer.byteLength + 16);
    bytes.set(footer, 0);
    new DataView(bytes.buffer, footer.byteLength, 8).setBigUint64(
      0,
      BigInt(footer.byteLength),
      true,
    );
    bytes.set(new TextEncoder().encode(PACK_MAGIC), footer.byteLength + 8);

    const error = await rejection(bytes);
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
    const footer = zstdCompress(
      JSON.stringify({
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
    const bytes = new Uint8Array(footer.byteLength + 16);
    bytes.set(footer, 0);
    new DataView(bytes.buffer, footer.byteLength, 8).setBigUint64(
      0,
      BigInt(footer.byteLength),
      true,
    );
    bytes.set(new TextEncoder().encode(PACK_MAGIC), footer.byteLength + 8);

    const error = await rejection(bytes);
    expect(error).toBeInstanceOf(CorpusPackError);
    expect(error).toMatchObject({
      message: expect.stringContaining("malformed"),
    });
  });
});

describe("writeCorpusPack", () => {
  test("PUTs the encoded pack once under the derived key", async () => {
    const puts: { key: string; bytes: Uint8Array }[] = [];
    const packId = newCorpusPackId();

    const { packKey: key, entries } = await writeCorpusPack({
      jurisdiction: "CZE",
      packId,
      members,
      put: async (putKey, bytes) => {
        puts.push({ key: putKey, bytes });
        await Promise.resolve();
      },
    });

    expect(key).toBe(`legal-corpus/packs/jurisdiction=CZE/${packId}.pack`);
    expect(puts).toHaveLength(1);
    const put = puts.at(0);
    if (put === undefined) {
      throw new Error("no PUT recorded");
    }
    expect(put.key).toBe(key);
    expect((await decodePackFooter(put.bytes)).members).toEqual(
      entries.map(({ member }) => member),
    );
    expect(entries.every(({ location }) => location.packKey === key)).toBe(
      true,
    );
  });
});
