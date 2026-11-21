import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createSafeId } from "@/api/lib/branded-types";
import { CorpusPayloadUnavailableError } from "@/api/lib/errors/tagged-errors";

import { readServedDecisionText } from "./served-text";

const decisionId = createSafeId<"caseLawDecision">();
const unreadable = () =>
  Promise.reject(
    new CorpusPayloadUnavailableError({
      message: "Fixture object unavailable",
      documentId: decisionId,
      key: "text-key",
    }),
  );

for (const text of [null, "", "Stored row document."]) {
  test(`failed canonical text uses only a readable row fallback: ${JSON.stringify(text)}`, async () => {
    const read = readServedDecisionText({
      textS3Key: "text-key",
      contentHash: "content-hash",
      decisionId,
      corpusReadEnabled: true,
      readStore: unreadable,
      readRow: async () => text,
    });
    if (text === null || text === "") {
      expect(await rejectionOf(read)).toBeInstanceOf(
        CorpusPayloadUnavailableError,
      );
    } else {
      expect(await read).toBe(text);
    }
  });
}

test("an actually read empty object remains distinct from a failed object", async () => {
  expect(
    await readServedDecisionText({
      textS3Key: "text-key",
      contentHash: "content-hash",
      decisionId,
      corpusReadEnabled: true,
      readStore: async () => "",
      readRow: unreadable,
    }),
  ).toBe("");
  expect(
    await readServedDecisionText({
      textS3Key: null,
      contentHash: null,
      decisionId,
      corpusReadEnabled: false,
      readStore: unreadable,
      readRow: async () => "",
    }),
  ).toBe("");
});
