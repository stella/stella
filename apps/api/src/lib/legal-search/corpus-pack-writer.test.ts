import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { zstdCompress } from "@/api/lib/compression";
import { formatCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import {
  decodePackFooter,
  packJurisdictionPrefix,
} from "@/api/lib/legal-search/corpus-pack";
import {
  corpusPackMemberWeight,
  CORPUS_PACK_MAX_BYTES,
  planCorpusPacks,
  putCorpusPacks,
} from "@/api/lib/legal-search/corpus-pack-writer";
import type { CorpusPackMemberInput } from "@/api/lib/legal-search/corpus-pack-writer";

const JURISDICTION = "CZE";
const FIRST_DOCUMENT = "0d2f4a5e-9c1b-4c62-8b1a-3f6f2f8f9e10";
const SECOND_DOCUMENT = "3a1c7b92-5d4e-4f08-9c62-1b8e5d2a4c77";

const members: CorpusPackMemberInput[] = [
  {
    documentId: FIRST_DOCUMENT,
    kind: "text",
    contentHash: "a".repeat(64),
    bytes: zstdCompress("Rozsudek jménem republiky."),
  },
  {
    documentId: FIRST_DOCUMENT,
    kind: "sections",
    contentHash: "a".repeat(64),
    bytes: zstdCompress('[{"index":0,"type":"ruling"}]'),
  },
  {
    documentId: SECOND_DOCUMENT,
    kind: "text",
    contentHash: "b".repeat(64),
    bytes: zstdCompress("Usnesení Nejvyššího soudu."),
  },
];

type RecordedPut = { key: string; bytes: Uint8Array };

/** A store that records what the writer asked of it. */
const fakeStore = (holds: (key: string) => boolean) => {
  const puts: RecordedPut[] = [];
  const headed: string[] = [];
  return {
    puts,
    headed,
    exists: async (key: string) => {
      headed.push(key);
      return await Promise.resolve(holds(key));
    },
    put: async (key: string, bytes: Uint8Array) => {
      puts.push({ key, bytes });
      await Promise.resolve();
    },
  };
};

describe("planning a batch's packs", () => {
  test("every member has an address before anything is transferred", async () => {
    const planned = await planCorpusPacks({
      jurisdiction: JURISDICTION,
      members,
    });
    if (Result.isError(planned)) {
      throw planned.error;
    }
    const { packs, packKeys, locations } = planned.value;

    expect(packs).toHaveLength(1);
    const pack = packs.at(0);
    if (pack === undefined) {
      throw new Error("the batch planned no pack");
    }
    expect(packKeys).toEqual([pack.packKey]);
    expect(pack.packKey.startsWith(packJurisdictionPrefix(JURISDICTION))).toBe(
      true,
    );
    // Every member is addressable by the document and kind it was handed
    // over as: that pairing is what the caller records its pointers under.
    expect([...locations.keys()].toSorted()).toEqual(
      [FIRST_DOCUMENT, SECOND_DOCUMENT].toSorted(),
    );
    expect(Object.keys(locations.get(FIRST_DOCUMENT) ?? {}).toSorted()).toEqual(
      ["sections", "text"],
    );
    for (const [documentId, byKind] of locations) {
      for (const [kind, location] of Object.entries(byKind)) {
        const member = members.find(
          (candidate) =>
            candidate.documentId === documentId && candidate.kind === kind,
        );
        if (member === undefined) {
          throw new Error(`no member for ${documentId}/${kind}`);
        }
        expect(location.packKey).toBe(pack.packKey);
        expect(location.length).toBe(member.bytes.byteLength);
        expect([
          ...pack.bytes.subarray(
            location.offset,
            location.offset + location.length,
          ),
        ]).toEqual([...member.bytes]);
      }
    }
  });

  test("a batch with no members plans no pack", async () => {
    const planned = await planCorpusPacks({
      jurisdiction: JURISDICTION,
      members: [],
    });
    if (Result.isError(planned)) {
      throw planned.error;
    }

    expect(planned.value.packs).toEqual([]);
    expect(planned.value.packKeys).toEqual([]);
    expect(planned.value.locations.size).toBe(0);
  });
});

describe("transferring a batch's packs", () => {
  test("a pack the store does not hold is PUT once under its own key", async () => {
    const store = fakeStore(() => false);

    const planned = await planCorpusPacks({
      jurisdiction: JURISDICTION,
      members,
    });
    if (Result.isError(planned)) {
      throw planned.error;
    }
    const written = await putCorpusPacks({
      packs: planned.value.packs,
      exists: store.exists,
      put: store.put,
    });
    if (Result.isError(written)) {
      throw written.error;
    }

    expect(store.puts).toHaveLength(1);
    const put = store.puts.at(0);
    if (put === undefined) {
      throw new Error("no PUT recorded");
    }
    expect(planned.value.packKeys).toEqual([put.key]);
    expect(store.headed).toEqual([put.key]);
    // What landed is the pack those addresses point into: every member of
    // the transferred object is reachable at the address the caller was
    // handed for it.
    const decoded = await decodePackFooter(put.bytes);
    if (Result.isError(decoded)) {
      throw decoded.error;
    }
    const footer = decoded.value;
    const transferred = footer.members.map(
      ({ documentId, kind, offset, length, sha256 }) => ({
        documentId,
        kind,
        address: formatCorpusLocation({
          type: "packed",
          packKey: put.key,
          offset,
          length,
          sha256,
        }),
      }),
    );
    const reported = members.map(({ documentId, kind }) => {
      const location = planned.value.locations.get(documentId)?.[kind];
      if (location === undefined) {
        throw new Error(`no address for ${documentId}/${kind}`);
      }
      return { documentId, kind, address: formatCorpusLocation(location) };
    });

    expect(transferred).toEqual(reported);
  });

  test("a replayed batch transfers nothing when the store already holds its pack", async () => {
    // The key is derived from the members, so a batch that is retried after
    // an ambiguous failure addresses the object the first attempt landed.
    const first = await planCorpusPacks({
      jurisdiction: JURISDICTION,
      members,
    });
    if (Result.isError(first)) {
      throw first.error;
    }
    const replay = await planCorpusPacks({
      jurisdiction: JURISDICTION,
      members,
    });
    if (Result.isError(replay)) {
      throw replay.error;
    }
    expect(replay.value.packKeys).toEqual(first.value.packKeys);

    const store = fakeStore((key) => first.value.packKeys.includes(key));
    const transferred = await putCorpusPacks({
      packs: replay.value.packs,
      exists: store.exists,
      put: store.put,
    });

    expect(Result.isOk(transferred)).toBe(true);
    expect(store.headed).toEqual(replay.value.packKeys);
    expect(store.puts).toEqual([]);
  });

  test("a failed transfer is reported as a pack error, not thrown", async () => {
    const planned = await planCorpusPacks({
      jurisdiction: JURISDICTION,
      members,
    });
    if (Result.isError(planned)) {
      throw planned.error;
    }
    const denied = await putCorpusPacks({
      packs: planned.value.packs,
      exists: async () => await Promise.resolve(false),
      put: async () => await Promise.reject(new Error("AccessDenied")),
    });

    expect(Result.isError(denied)).toBe(true);
    if (Result.isOk(denied)) {
      throw new Error("the transfer was expected to fail");
    }
    expect(denied.error.message).toContain("Corpus pack write failed");
  });
});

describe("the ceiling counts what the writer will buffer", () => {
  /** A member that only fits once nothing else shares its pack. */
  const large = (documentId: string, bytes: number): CorpusPackMemberInput => ({
    documentId,
    kind: "text",
    contentHash: "c".repeat(64),
    bytes: new Uint8Array(bytes),
  });

  test("a member that fills the ceiling on its own travels alone", async () => {
    const planned = await planCorpusPacks({
      jurisdiction: JURISDICTION,
      members: [
        large(FIRST_DOCUMENT, CORPUS_PACK_MAX_BYTES - 1024),
        large(SECOND_DOCUMENT, 1024),
      ],
    });
    if (Result.isError(planned)) {
      throw planned.error;
    }

    // Two packs, not one 64 MiB object with a second member appended: the
    // writer holds a whole pack in memory before it transfers it.
    expect(planned.value.packKeys).toHaveLength(2);
  });

  test("the footer a member will carry counts against the ceiling", async () => {
    // Payload bytes alone fit; the footer entries are what push the group
    // over, which is exactly the case a payload-only bound would miss.
    const size = Math.floor(CORPUS_PACK_MAX_BYTES / 4);
    const quarters = [
      large(FIRST_DOCUMENT, size),
      large(SECOND_DOCUMENT, size),
      large("11111111-2222-3333-4444-555555555555", size),
      large("66666666-7777-8888-9999-aaaaaaaaaaaa", size),
    ];
    expect(
      quarters.reduce((total, { bytes }) => total + bytes.byteLength, 0),
    ).toBeLessThanOrEqual(CORPUS_PACK_MAX_BYTES);
    expect(
      quarters.reduce(
        (total, { bytes }) => total + corpusPackMemberWeight(bytes),
        0,
      ),
    ).toBeGreaterThan(CORPUS_PACK_MAX_BYTES);

    const planned = await planCorpusPacks({
      jurisdiction: JURISDICTION,
      members: quarters,
    });
    if (Result.isError(planned)) {
      throw planned.error;
    }

    expect(planned.value.packKeys).toHaveLength(2);
  });
});
