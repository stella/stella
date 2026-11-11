import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { FACT_TIERS } from "@/api/lib/lists/source-kind";
import type { FactTier } from "@/api/lib/lists/source-kind";
import { suggestedGoverningFactId } from "@/api/lib/lists/verification/governing-suggestion";

const A = toSafeId<"entity">("00000000-0000-4000-8000-000000000001");
const B = toSafeId<"entity">("00000000-0000-4000-8000-000000000002");

const suggest = (first: FactTier, second: FactTier) =>
  suggestedGoverningFactId({
    conflict: { factEntityIds: [A, B] },
    tierOf: (id) => (id === A ? first : second),
  });

describe("suggestedGoverningFactId", () => {
  test("the document's record is suggested over a person's account, on either side", () => {
    expect(suggest("document", "testimony")).toBe(A);
    expect(suggest("testimony", "document")).toBe(B);
  });

  test("every other pairing suggests neither record", () => {
    const suggesting = FACT_TIERS.flatMap((first) =>
      FACT_TIERS.map((second) => ({
        pair: `${first}/${second}`,
        factId: suggest(first, second),
      })),
    ).filter(({ factId }) => factId !== null);
    expect(suggesting.map(({ pair }) => pair).toSorted()).toEqual([
      "document/testimony",
      "testimony/document",
    ]);
  });
});
