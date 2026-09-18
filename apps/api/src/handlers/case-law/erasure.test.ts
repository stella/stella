import { describe, expect, test } from "bun:test";

import {
  eraseCancelledIntentObjects,
  eraseCorpusObjects,
} from "@/api/handlers/case-law/erasure";
import { createSafeId } from "@/api/lib/branded-types";
import { formatCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import type { PackedCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import type { CorpusDeleteOutcome } from "@/api/lib/legal-search/corpus-storage";
import type { CorpusTombstoneEntry } from "@/api/lib/legal-search/corpus-tombstones";

const decisionId = createSafeId<"caseLawDecision">();
const objectKey =
  "legal-corpus/documents/jurisdiction=SVK/d/h/sections.json.zst";
const packedLocation: PackedCorpusLocation = {
  type: "packed",
  packKey: "legal-corpus/packs/jurisdiction=SVK/01912f6a.stlpack",
  offset: 128,
  length: 64,
  sha256: "a".repeat(64),
};
const packedAddress = formatCorpusLocation(packedLocation);
const keys = { textKey: packedAddress, sectionsKey: objectKey, astKey: null };

const recordingTombstone = () => {
  const written: CorpusTombstoneEntry[] = [];
  return {
    written,
    tombstone: async (entries: readonly CorpusTombstoneEntry[]) => {
      written.push(...entries);
      await Promise.resolve();
    },
  };
};

const deleteReporting =
  (outcome: CorpusDeleteOutcome) => async (): Promise<CorpusDeleteOutcome> =>
    await Promise.resolve(outcome);

describe("eraseCorpusObjects", () => {
  test("a member of a shared pack is erased by tombstoning its address", async () => {
    const { tombstone } = recordingTombstone();
    const erasure = await eraseCorpusObjects({
      keys,
      decisionId,
      tombstone,
      deleteCorpus: deleteReporting({
        type: "tombstoned",
        deletedKeys: [objectKey],
        tombstoned: [packedLocation],
      }),
    });

    // Not "incomplete": nothing serves the address again, which is what the
    // erasure has to achieve. It stays distinguishable from a delete because
    // only this one leaves bytes for a later rewrite of the pack.
    expect(erasure).toEqual({
      type: "tombstoned",
      tombstoned: [packedAddress],
    });
  });

  test("a delete that resolves with every object gone is reported deleted", async () => {
    const { tombstone } = recordingTombstone();
    expect(
      await eraseCorpusObjects({
        keys,
        decisionId,
        tombstone,
        deleteCorpus: deleteReporting({ type: "deleted", keys: [objectKey] }),
      }),
    ).toEqual({ type: "deleted" });
  });

  test("a failed delete carries its cause", async () => {
    const { tombstone } = recordingTombstone();
    const cause = new Error("bucket unreachable");
    expect(
      await eraseCorpusObjects({
        keys,
        decisionId,
        tombstone,
        deleteCorpus: async () => await Promise.reject(cause),
      }),
    ).toEqual({ type: "incomplete", error: cause });
  });
});

describe("eraseCancelledIntentObjects", () => {
  const gone = createSafeId<"caseLawCorpusUploadIntent">();
  const packed = createSafeId<"caseLawCorpusUploadIntent">();
  const cancelledIntents = [
    {
      id: gone,
      textKey: objectKey,
      sectionsKey: objectKey,
      astKey: objectKey,
    },
    {
      id: packed,
      textKey: packedAddress,
      sectionsKey: packedAddress,
      astKey: packedAddress,
    },
  ];

  test("a reservation whose members are tombstoned has nothing left to retry", async () => {
    const { tombstone } = recordingTombstone();
    const deleteCorpus = async (intentKeys: {
      textKey: string | null;
    }): Promise<CorpusDeleteOutcome> =>
      await Promise.resolve(
        intentKeys.textKey === objectKey
          ? { type: "deleted", keys: [objectKey] }
          : {
              type: "tombstoned",
              deletedKeys: [],
              tombstoned: [packedLocation],
            },
      );

    const erasure = await eraseCancelledIntentObjects({
      cancelledIntents,
      decisionId,
      tombstone,
      deleteCorpus,
    });

    expect(new Set(erasure.cleanedIntentIds)).toEqual(new Set([gone, packed]));
    expect(erasure.incomplete).toEqual([]);
  });

  test("a failed delete keeps the intent on the retry path", async () => {
    const { tombstone } = recordingTombstone();
    const cause = new Error("delete failed");
    const erasure = await eraseCancelledIntentObjects({
      cancelledIntents,
      decisionId,
      tombstone,
      deleteCorpus: async () => await Promise.reject(cause),
    });

    expect(erasure.cleanedIntentIds).toEqual([]);
    expect(erasure.incomplete.map((entry) => entry.error)).toEqual([
      cause,
      cause,
    ]);
  });
});
