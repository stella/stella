import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { readDecisionAnalysis } from "@/api/lib/case-law/decision-analysis";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const DECISION_ID = toSafeId<"caseLawDecision">(
  "11111111-1111-4111-8111-111111111111",
);

describe("readDecisionAnalysis", () => {
  test("loads the source's reuse terms alongside its adapter key", async () => {
    let args: { with?: { source?: { columns?: Record<string, boolean> } } } =
      {};
    const tx = asTestRaw<CaseLawPublicReadTransaction>({
      query: {
        caseLawDecisions: {
          findFirst: async (received: typeof args) => {
            args = received;
            return null;
          },
        },
      },
    });

    await readDecisionAnalysis(tx, DECISION_ID);

    // The analysis path feeds decision text to a model, so it has to be able
    // to read the licence bit that decides whether it may.
    expect(args.with?.source?.columns).toEqual({
      adapterKey: true,
      descriptor: true,
    });
  });
});
