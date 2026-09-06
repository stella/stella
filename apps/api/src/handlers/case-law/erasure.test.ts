import { describe, expect, test } from "bun:test";

import {
  CorpusObjectRetainedError,
  eraseCancelledIntentObjects,
  eraseCorpusObjects,
} from "@/api/handlers/case-law/erasure";
import { createSafeId } from "@/api/lib/branded-types";
import { formatCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import type { PackedCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import type { CorpusDeleteOutcome } from "@/api/lib/legal-search/corpus-storage";

const objectKey =
  "legal-corpus/documents/jurisdiction=SVK/d/h/sections.json.zst";
const packedLocation: PackedCorpusLocation = {
  type: "packed",
  packKey: "legal-corpus/packs/jurisdiction=SVK/01912f6a.pack",
  offset: 128,
  length: 64,
};
const packedAddress = formatCorpusLocation(packedLocation);
const keys = { textKey: packedAddress, sectionsKey: objectKey, astKey: null };

const deleteReporting =
  (outcome: CorpusDeleteOutcome) => async (): Promise<CorpusDeleteOutcome> =>
    await Promise.resolve(outcome);

describe("eraseCorpusObjects", () => {
  test("a pointer into an object that holds other members is not reported erased", async () => {
    // The delete itself resolves: the standalone sibling went, the shared
    // object stayed. That resolution must not read as a complete erasure.
    const erasure = await eraseCorpusObjects({
      keys,
      deleteCorpus: deleteReporting({
        type: "shared-object-retained",
        deletedKeys: [objectKey],
        retained: [packedLocation],
      }),
    });

    expect(erasure.type).toBe("incomplete");
    if (erasure.type !== "incomplete") {
      throw new Error("expected an incomplete erasure");
    }
    expect(erasure.error).toBeInstanceOf(CorpusObjectRetainedError);
    expect(erasure.error).toMatchObject({
      retained: [packedAddress],
      message: expect.stringContaining(packedAddress),
    });
  });

  test("a delete that resolves with every object gone is reported deleted", async () => {
    expect(
      await eraseCorpusObjects({
        keys,
        deleteCorpus: deleteReporting({ type: "deleted", keys: [objectKey] }),
      }),
    ).toEqual({ type: "deleted" });
  });

  test("a failed delete carries its cause", async () => {
    const cause = new Error("bucket unreachable");
    expect(
      await eraseCorpusObjects({
        keys,
        deleteCorpus: async () => await Promise.reject(cause),
      }),
    ).toEqual({ type: "incomplete", error: cause });
  });
});

describe("eraseCancelledIntentObjects", () => {
  const gone = createSafeId<"caseLawCorpusUploadIntent">();
  const kept = createSafeId<"caseLawCorpusUploadIntent">();
  const cancelledIntents = [
    {
      id: gone,
      textKey: objectKey,
      sectionsKey: objectKey,
      astKey: objectKey,
    },
    {
      id: kept,
      textKey: packedAddress,
      sectionsKey: packedAddress,
      astKey: packedAddress,
    },
  ];

  test("only an intent whose every object is gone is cleaned", async () => {
    const deleteCorpus = async (intentKeys: {
      textKey: string | null;
    }): Promise<CorpusDeleteOutcome> =>
      await Promise.resolve(
        intentKeys.textKey === objectKey
          ? { type: "deleted", keys: [objectKey] }
          : {
              type: "shared-object-retained",
              deletedKeys: [],
              retained: [packedLocation],
            },
      );

    const erasure = await eraseCancelledIntentObjects({
      cancelledIntents,
      deleteCorpus,
    });

    expect(erasure.cleanedIntentIds).toEqual([gone]);
    expect(erasure.incomplete).toHaveLength(1);
    expect(erasure.incomplete.at(0)?.intentId).toBe(kept);
    expect(erasure.incomplete.at(0)?.error).toBeInstanceOf(
      CorpusObjectRetainedError,
    );
  });

  test("a failed delete keeps the intent on the retry path", async () => {
    const cause = new Error("delete failed");
    const erasure = await eraseCancelledIntentObjects({
      cancelledIntents,
      deleteCorpus: async () => await Promise.reject(cause),
    });

    expect(erasure.cleanedIntentIds).toEqual([]);
    expect(erasure.incomplete.map((entry) => entry.error)).toEqual([
      cause,
      cause,
    ]);
  });
});
