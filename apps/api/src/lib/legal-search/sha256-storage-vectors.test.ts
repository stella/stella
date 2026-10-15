import { expect, test } from "bun:test";

import { corpusContentHash } from "./corpus-content-hash";
import { corpusIndexContractDigest } from "./corpus-index-manifest";
import { corpusMemberDigest, packKeyForMembers } from "./corpus-pack";
import { corpusQueryVariantCursorTarget } from "./corpus-query-variant-policy";
import { corpusRankingCursorTarget } from "./corpus-ranking-policy";
import { corpusSearchGroupToken } from "./corpus-search-cursor";
import { fingerprintReconciliationPayload } from "./reconciliation-payload";

// Fixed digests pin the serialized storage and cursor contracts independently of the owner.
test("stored corpus identities preserve their serialized byte vectors", () => {
  expect(corpusContentHash({ text: null, sections: null, ast: null })).toBe(
    "c21295bcba9c492b8fa6894ee2fcd6ca93b825ea61fc4965d00f41ea611071e2",
  );
  expect(corpusContentHash({ text: "Článek ⚖", sections: [], ast: null })).toBe(
    "9322bf386d9ce6d0fa51800485e7062b1ef1263a051fa3c223c46425839edacf",
  );
  expect(corpusIndexContractDigest({ z: [2, 1], a: "Článek" })).toBe(
    "499203df602dcf65384ded449e5aa018cd968f1736de7c89d70930fe88716f0a",
  );
  expect(
    fingerprintReconciliationPayload({
      z: undefined,
      b: [undefined, 2],
      a: "Článek",
    }),
  ).toBe("63c0adf87eeff63ad140920063a864476194e76d88a55553f0423b3fdb0c782d");
  const bytes = new Uint8Array([99, 0, 255, 128, 1, 88]).subarray(1, 5);
  expect(corpusMemberDigest(bytes)).toBe(
    "6509423fd9da5c225d2f8619ffae394b40f9f7686fee55a38c54b1424ac65f46",
  );
  expect(
    packKeyForMembers({
      jurisdiction: "SVK",
      members: [
        {
          documentId: "document-1",
          kind: "text",
          sha256:
            "6509423fd9da5c225d2f8619ffae394b40f9f7686fee55a38c54b1424ac65f46",
          length: 4,
        },
      ],
    }),
  ).toBe(
    "legal-corpus/packs/jurisdiction=SVK/586e4254bb8c84df204060e2641abba4e4c664bc583f49b72f6c6f576beb0e90.stlpack",
  );
});

test("cursor identities preserve UTF-8 encoding and digest prefixes", () => {
  expect(corpusQueryVariantCursorTarget(null, "provision-refs")).toBe(
    "dff45409e2fcf66a203cc49cbc917c39",
  );
  expect(corpusQueryVariantCursorTarget(null, "core-stems-first")).toBe(
    "9be357e11e6d08c236db7acd70325ffe",
  );
  expect(
    corpusQueryVariantCursorTarget(null, "provision-refs-core-stems-first"),
  ).toBe("4e3d21621d63be1e1f677cb3bfb9c990");
  expect(corpusRankingCursorTarget(null, "bm25-ratio")).toBe(
    "1e60417503a4205c659ed69cb49065d9",
  );
  expect(corpusQueryVariantCursorTarget("Článek ⚖", "provision-refs")).toBe(
    "59765fa5159dc5421ca6f03b49a98e7d",
  );
  expect(corpusQueryVariantCursorTarget("Článek ⚖", "core-stems-first")).toBe(
    "a3a0829b42b10d6e4048fe1586391d5d",
  );
  expect(
    corpusQueryVariantCursorTarget(
      "Článek ⚖",
      "provision-refs-core-stems-first",
    ),
  ).toBe("3e93857279c2215939dda191e482fed8");
  expect(corpusRankingCursorTarget("Článek ⚖", "bm25-ratio")).toBe(
    "7ef8a21451b6db226ff5f56ecaf3a827",
  );
  expect(corpusQueryVariantCursorTarget("", "provision-refs")).toBe(
    "269e043df6f629d9b00bee7e66fcbef1",
  );
  expect(corpusQueryVariantCursorTarget("", "core-stems-first")).toBe(
    "2280ac6db029678bfcecd2ae2765c500",
  );
  expect(
    corpusQueryVariantCursorTarget("", "provision-refs-core-stems-first"),
  ).toBe("b62d96de22baf11e8fef0de44cd47ded");
  expect(corpusRankingCursorTarget("", "bm25-ratio")).toBe(
    "437f9036f6f32b0f5e7e29e0522093bc",
  );
  expect(corpusSearchGroupToken("Článek ⚖")).toBe("6491mB");
  expect(corpusQueryVariantCursorTarget(null, "off")).toBeNull();
  expect(corpusRankingCursorTarget("Článek ⚖", "off")).toBe("Článek ⚖");
});
