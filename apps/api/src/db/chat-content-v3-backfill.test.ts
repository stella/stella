import { describe, expect, test } from "bun:test";

import goldenFixtures from "./__fixtures__/chat-content-v3-legacy-goldens.json" with { type: "json" };
import { convertLegacyChatContent } from "./chat-content-v3-legacy";

describe("frozen legacy conversion preserves pre-cutover persisted output", () => {
  test("captured fixtures exercise both retired versions", () => {
    expect(new Set(goldenFixtures.map(({ input }) => input.version))).toEqual(
      new Set([1, 2]),
    );
  });
  for (const { name, input, expected } of goldenFixtures) {
    test(name, () => {
      expect(convertLegacyChatContent(input)).toEqual(expected);
    });
  }
});

test("the migration rejects corrupt envelopes and unsupported versions", () => {
  for (const invalid of [
    null,
    [],
    { version: 1 },
    { version: 2, data: null },
  ]) {
    expect(() => convertLegacyChatContent(invalid)).toThrow(
      "Stored legacy chat content has invalid data",
    );
  }
  for (const version of [0, 3, 4, "1", null]) {
    expect(() => convertLegacyChatContent({ version, data: [] })).toThrow(
      "Legacy chat conversion requires version 1 or 2",
    );
  }
  expect(() =>
    convertLegacyChatContent({
      version: 2,
      data: [{ type: "text", content: 42 }],
    }),
  ).toThrow("Stored v2 chat content has invalid parts");
  expect(() =>
    convertLegacyChatContent({ version: 2, data: [], metadata: "invalid" }),
  ).toThrow("Stored v2 chat content has invalid metadata");
});
