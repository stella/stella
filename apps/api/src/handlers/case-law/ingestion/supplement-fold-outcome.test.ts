import { expect, test } from "bun:test";

import type { SupplementDisposition } from "@/api/handlers/case-law/ingestion/pipeline/supplement-types";
import {
  foldOutcomeOf,
  SUPPLEMENT_FOLD_OUTCOME,
} from "@/api/handlers/case-law/ingestion/supplement-fold";
import { createSafeId } from "@/api/lib/branded-types";

const judgmentId = createSafeId<"caseLawDecision">();

test.each([
  [
    { type: "merged", judgmentId },
    { outcome: SUPPLEMENT_FOLD_OUTCOME.MERGED, detail: judgmentId },
  ],
  [
    { type: "standalone", reason: "no-judgment" },
    { outcome: SUPPLEMENT_FOLD_OUTCOME.STANDALONE, detail: "no-judgment" },
  ],
  [
    { type: "withheld", judgmentId },
    { outcome: SUPPLEMENT_FOLD_OUTCOME.WITHHELD, detail: judgmentId },
  ],
  [
    { type: "erased", decisionId: judgmentId },
    { outcome: SUPPLEMENT_FOLD_OUTCOME.WITHHELD, detail: judgmentId },
  ],
  [
    { type: "removed", formerJudgmentId: judgmentId },
    { outcome: SUPPLEMENT_FOLD_OUTCOME.WITHHELD, detail: judgmentId },
  ],
] as const satisfies readonly (readonly [
  SupplementDisposition,
  ReturnType<typeof foldOutcomeOf>,
])[])("a %j supplement folds as %j", (disposition, expected) => {
  expect(foldOutcomeOf(disposition)).toEqual(expected);
});
