import { panic } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  extractedReplayMetadata,
  STORED_REPLAY_METADATA_KEYS,
  storedReplayMetadata,
} from "./stored-replay-write";

const publisherProjection = (metadata: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(metadata).filter(
      ([key]) =>
        !STORED_REPLAY_METADATA_KEYS.some((allowed) => allowed === key),
    ),
  );

test("replay metadata merge preserves the entire publisher projection byte for byte", async () => {
  await assertProperty(
    "replay metadata merge preserves the entire publisher projection byte for byte",
    fc.asyncProperty(
      fc.dictionary(fc.string({ maxLength: 30 }), fc.jsonValue()),
      fc.dictionary(
        fc
          .integer({ min: 0, max: STORED_REPLAY_METADATA_KEYS.length - 1 })
          .map(
            (index) =>
              STORED_REPLAY_METADATA_KEYS.at(index) ??
              panic("Missing derived metadata key"),
          ),
        fc.jsonValue(),
      ),
      async (stored, patch) => {
        const before = JSON.stringify(publisherProjection(stored));
        const merged = storedReplayMetadata(stored, patch);
        expect(JSON.stringify(publisherProjection(merged))).toBe(before);
        expect(extractedReplayMetadata(merged)).toEqual(patch);
        expect(JSON.stringify(publisherProjection(stored))).toBe(before);
      },
    ),
    { numRuns: 100 },
  );
});

test("replay metadata merge refuses publisher and unclassified patch keys", () => {
  for (const key of ["headnote", "publisher", "unclassifiedPipelineKey"]) {
    const patch = Object.fromEntries([[key, "replacement"]]);
    expect(() => storedReplayMetadata({ [key]: "original" }, patch)).toThrow(
      `Stored replay cannot merge metadata key ${key}`,
    );
  }
});
