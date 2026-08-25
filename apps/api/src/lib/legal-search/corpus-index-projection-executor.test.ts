import { expect, test } from "bun:test";

import { PayloadBudgetError } from "@/api/lib/compression";
import { classifyCorpusProjectionPayloadReadFailure } from "@/api/lib/legal-search/corpus-index-projection-executor";

test("payload budget failures block on the first read", () => {
  expect(
    classifyCorpusProjectionPayloadReadFailure(
      new PayloadBudgetError({ message: "payload too large" }),
    ),
  ).toEqual({
    kind: "revision_too_large",
    message: "projection payload exceeds the transfer or decode ceiling",
  });
});

test("transient payload failures remain retryable", () => {
  expect(
    classifyCorpusProjectionPayloadReadFailure(new Error("socket closed")),
  ).toEqual({
    kind: "payload_unavailable",
    message: "projection payload read failed before append",
  });
});
