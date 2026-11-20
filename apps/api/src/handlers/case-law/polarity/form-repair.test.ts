import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import {
  POLARITIES,
  POLARITY,
  POLARITY_CLASSIFIER_VERSION,
} from "@/api/handlers/case-law/polarity/consts";
import {
  formRepairPlanSchema,
  planFormRepair,
} from "@/api/handlers/case-law/polarity/form-repair";
import { compileRules } from "@/api/handlers/case-law/polarity/rule-engine";
import { createSafeId } from "@/api/lib/branded-types";

const ruleId = createSafeId<"caseLawPolarityRule">();
const oldRuleId = createSafeId<"caseLawPolarityRule">();
const citationId = createSafeId<"caseLawCitation">();
const rules = compileRules([
  {
    id: ruleId,
    pattern: "compare",
    kind: "form",
    polarity: "neutral",
    confidence: 1,
  },
  {
    id: createSafeId<"caseLawPolarityRule">(),
    pattern: "reject",
    kind: "stance",
    polarity: "negative",
    confidence: 1,
  },
]);
const candidate = {
  id: citationId,
  citingDecisionId: createSafeId<"caseLawDecision">(),
  jurisdiction: "XX",
  contentHash: null,
  polarity: POLARITY.SUPPORTIVE,
  ruleId: oldRuleId,
  citationText: "A 12/2020",
  sectionIndex: 0,
  sections: [{ text: "compare A 12/2020" }],
};

describe("form-derived citation repair", () => {
  test("a neutral rereading repairs each non-neutral stored label", () => {
    assertProperty(
      "a neutral rereading repairs each non-neutral stored label",
      fc.property(fc.constantFrom(...POLARITIES), (polarity) => {
        const planned = planFormRepair({ ...candidate, polarity }, rules);
        expect(planned.status).toBe(
          polarity === POLARITY.NEUTRAL ? "retained" : "repair",
        );
        if (planned.status === "repair" && polarity !== POLARITY.NEUTRAL) {
          expect(planned.row.oldPolarity).toBe(polarity);
          expect(planned.row.newPolarity).toBe(POLARITY.NEUTRAL);
        }
      }),
    );
  });

  test("an actual rejection is retained rather than downgraded", () => {
    const planned = planFormRepair(
      { ...candidate, sections: [{ text: "reject, compare A 12/2020" }] },
      rules,
    );
    expect(planned.status).toBe("retained");
  });

  test("missing context, unmatched text and an unattributed label cannot be repaired", () => {
    expect(planFormRepair({ ...candidate, sections: null }, rules).status).toBe(
      "no-context",
    );
    expect(
      planFormRepair({ ...candidate, sections: [{ text: "A 12/2020" }] }, rules)
        .status,
    ).toBe("retained");
    expect(planFormRepair({ ...candidate, ruleId: null }, rules).status).toBe(
      "retained",
    );
    expect(planFormRepair({ ...candidate, polarity: null }, rules).status).toBe(
      "retained",
    );
  });

  test("preview snapshots change when text, label or rule changes", () => {
    const original = planFormRepair(candidate, rules);
    expect(original.status).toBe("repair");
    if (original.status !== "repair") {
      return;
    }
    for (const changed of [
      { ...candidate, sections: [{ text: "compare A 12/2020 again" }] },
      { ...candidate, polarity: POLARITY.POSITIVE },
      { ...candidate, ruleId: createSafeId<"caseLawPolarityRule">() },
    ]) {
      const planned = planFormRepair(changed, rules);
      expect(planned.status).toBe("repair");
      if (planned.status === "repair") {
        expect(planned.row.fingerprint).not.toBe(original.row.fingerprint);
      }
    }
  });

  test("apply files accept only neutral transitions and the current classifier version", () => {
    const planned = planFormRepair(candidate, rules);
    expect(planned.status).toBe("repair");
    if (planned.status !== "repair") {
      return;
    }
    const plan = {
      classifierVersion: POLARITY_CLASSIFIER_VERSION,
      language: "en",
      after: null,
      rows: [{ ...planned.row, ruleFingerprint: "synthetic-rule-identity" }],
      results: [],
      counts: {},
      read: 1,
      noContext: 0,
    };
    expect(v.safeParse(formRepairPlanSchema, plan).success).toBe(true);
    for (const polarity of POLARITIES.filter(
      (value) => value !== POLARITY.NEUTRAL,
    )) {
      expect(
        v.safeParse(formRepairPlanSchema, {
          ...plan,
          rows: [
            {
              ...planned.row,
              ruleFingerprint: "synthetic-rule-identity",
              newPolarity: polarity,
            },
          ],
        }).success,
      ).toBe(false);
    }
    expect(
      v.safeParse(formRepairPlanSchema, {
        ...plan,
        classifierVersion: "obsolete",
      }).success,
    ).toBe(false);
  });
});
