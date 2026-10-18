import { describe, expect, test } from "bun:test";

import { caseLawSources, publishedCaseLawDecisions } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { readDecisionAnalysis } from "@/api/lib/case-law/decision-analysis";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const DECISION_ID = toSafeId<"caseLawDecision">(
  "11111111-1111-4111-8111-111111111111",
);

describe("readDecisionAnalysis", () => {
  test("loads the source's reuse terms alongside its adapter key", async () => {
    let selection: unknown;
    let relation: unknown;
    const tx = asTestRaw<CaseLawPublicReadTransaction>({
      select: (received: unknown) => {
        selection = received;
        return {
          from: (receivedRelation: unknown) => {
            relation = receivedRelation;
            return {
              leftJoin: () => ({
                where: () => ({ limit: async () => [] }),
              }),
            };
          },
        };
      },
    });

    await readDecisionAnalysis(tx, DECISION_ID);

    expect(relation).toBe(publishedCaseLawDecisions);
    expect(selection).toEqual(
      expect.objectContaining({
        source: {
          adapterKey: caseLawSources.adapterKey,
          descriptor: caseLawSources.descriptor,
        },
      }),
    );
  });
});
