import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Fetcher } from "@stll/fetch";

import {
  HOUSE_DOCUMENT_XML,
  HOUSE_NUMBERING_XML,
  HOUSE_STYLES_XML,
  SOURCE_DOCUMENT_XML,
  SYNTHETIC_GUIDE_DRAFT,
} from "@/api/lib/house-style/__fixtures__/synthetic-style-set";
import {
  assignHouseStyles,
  buildBatchRequest,
  NO_HOUSE_STYLE,
  planDecisionBatches,
  planRuleTier,
  ruleStyleId,
} from "@/api/lib/house-style/assign";
import {
  extractStyleCatalogue,
  readStyleDefinitions,
} from "@/api/lib/house-style/catalogue";
import {
  bindStyleGuide,
  parseStyleGuideDraft,
} from "@/api/lib/house-style/guide";
import type { StyleGuide } from "@/api/lib/house-style/guide";
import {
  extractParagraphFeatures,
  readBodyParagraphs,
} from "@/api/lib/house-style/paragraphs";
import type { ParagraphFeatures } from "@/api/lib/house-style/paragraphs";
import type { DecisionModel } from "@/api/lib/workflow/decisions/decision-model";
import { createSystemOneClient } from "@/api/lib/workflow/decisions/system-one";

const catalogue = extractStyleCatalogue({
  stylesXml: HOUSE_STYLES_XML,
  numberingXml: HOUSE_NUMBERING_XML,
  documentXml: HOUSE_DOCUMENT_XML,
});

const guideOf = (): StyleGuide => {
  const draft = parseStyleGuideDraft(structuredClone(SYNTHETIC_GUIDE_DRAFT));
  if (Result.isError(draft)) {
    throw new TypeError("the synthetic guide does not parse");
  }
  const bound = bindStyleGuide({ draft: draft.value, catalogue });
  if (Result.isError(bound)) {
    throw new TypeError("the synthetic guide does not bind to its catalogue");
  }
  return bound.value;
};

const guide = guideOf();

const features = extractParagraphFeatures({
  paragraphs: readBodyParagraphs(SOURCE_DOCUMENT_XML),
  definitions: readStyleDefinitions({
    stylesXml: HOUSE_STYLES_XML,
    numberingXml: HOUSE_NUMBERING_XML,
  }),
});

type WireRequest = {
  questions: Record<string, { criteria: Record<string, unknown> }>;
};

/**
 * A client over a fake wire rather than a hand-typed answer object, so every
 * answer passes the transport's own per-question binding: a choice outside
 * its criteria would be a transport error here too.
 */
const wireAnswering = ({
  chosen,
  confidence,
  onCall,
}: {
  chosen: (key: string) => string;
  confidence: number;
  onCall?: () => void;
}): DecisionModel => {
  const fetcher: Fetcher = async (_input, init) => {
    onCall?.();
    const body: WireRequest = JSON.parse(
      typeof init?.body === "string" ? init.body : "{}",
    );
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries(body.questions)) {
      const options = Object.keys(question.criteria);
      const pick = chosen(key);
      const rest = (1 - confidence) / Math.max(1, options.length - 1);
      answers[key] = {
        type: "choice",
        choice: pick,
        probabilities: Object.fromEntries(
          options.map((option) => [
            option,
            option === pick ? confidence : rest,
          ]),
        ),
        confidence,
      };
    }
    return await Promise.resolve(
      new Response(
        JSON.stringify({
          model: "jev-test",
          answers,
          usage: { input_tokens: 120, output_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };
  return {
    ...createSystemOneClient({ apiKey: "key-test", fetcher }),
    keySource: "instance",
  };
};

const never = (): never => {
  throw new Error("the fixture is missing a value the test needs");
};

describe("planning the questions", () => {
  test("splits the paragraphs into batches of the given size", () => {
    const batches = planDecisionBatches(features, 4);
    expect(batches.map((batch) => batch.length)).toEqual([4, 2]);
    expect(batches.flat().map((feature) => feature.index)).toEqual(
      features.map((feature) => feature.index),
    );
  });

  test("asks one question per paragraph, over the guide plus an escape", () => {
    const { state, questions } = buildBatchRequest({ features, guide });
    expect(Object.keys(questions)).toEqual([
      "p0",
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
    ]);
    const criteria = Object.keys(questions["p0"]?.criteria ?? {});
    expect(criteria).toContain("Heading1Firm");
    expect(criteria).toContain(NO_HOUSE_STYLE);
    expect(criteria).toHaveLength(guide.styles.length + 1);
    expect(state["paragraphs"]).toHaveLength(features.length);
    expect(state["guide"]).toHaveLength(guide.styles.length);
  });

  test("keeps a batch independent of what another batch decided", () => {
    const [first, second] = planDecisionBatches(features, 3);
    const asked = buildBatchRequest({ features: second ?? never(), guide });
    expect(JSON.stringify(asked.state)).not.toContain(
      first?.at(0)?.text ?? "unreachable",
    );
  });
});

describe("the rule tier", () => {
  const plan = planRuleTier(catalogue);

  test("reads a hierarchy out of the catalogue", () => {
    expect(plan?.headingByLevel.get(0)).toBe("Heading1Firm");
    expect(plan?.headingByLevel.get(1)).toBe("Heading2Firm");
    expect(plan?.bodyStyleId).toBe("Normal");
  });

  test("maps an outline level to the house heading of that depth", () => {
    const heading: ParagraphFeatures = {
      ...(features.at(0) ?? never()),
      outlineLevel: 1,
    };
    expect(ruleStyleId(heading, plan ?? never())).toBe("Heading2Firm");
  });

  test("falls back to the main body style for prose it cannot place", () => {
    expect(ruleStyleId(features.at(2) ?? never(), plan ?? never())).toBe(
      "Normal",
    );
  });
});

describe("assigning house styles", () => {
  test("takes the model's choice when it is sure enough", async () => {
    const { assignments, usage } = await assignHouseStyles({
      features,
      guide,
      catalogue,
      orgAIConfig: null,
      client: wireAnswering({ chosen: () => "Heading1Firm", confidence: 0.9 }),
    });
    expect(assignments).toHaveLength(features.length);
    expect(assignments.every(({ tier }) => tier === "decision-model")).toBe(
      true,
    );
    expect(assignments.at(0)?.styleId).toBe("Heading1Firm");
    expect(assignments.at(0)?.probability).toBeCloseTo(0.9, 5);
    expect(usage.requests).toBe(1);
    expect(usage.inputTokens).toBe(120);
    expect(usage.model).toBe("jev-test");
  });

  test("falls to the rule when the model answers under the floor", async () => {
    const { assignments } = await assignHouseStyles({
      features,
      guide,
      catalogue,
      orgAIConfig: null,
      client: wireAnswering({ chosen: () => "Heading1Firm", confidence: 0.2 }),
    });
    expect(assignments.every(({ tier }) => tier === "rule")).toBe(true);
    expect(assignments.at(0)?.undecidedReason).toBe("below-floor");
    expect(assignments.at(0)?.probability).toBeNull();
  });

  test("falls to the rule when the model says no house style fits", async () => {
    const { assignments } = await assignHouseStyles({
      features,
      guide,
      catalogue,
      orgAIConfig: null,
      client: wireAnswering({ chosen: () => NO_HOUSE_STYLE, confidence: 0.95 }),
    });
    expect(assignments.every(({ tier }) => tier === "rule")).toBe(true);
    expect(assignments.every(({ styleId }) => styleId === "Normal")).toBe(true);
  });

  test("converts with no decision model at all", async () => {
    const { assignments, usage } = await assignHouseStyles({
      features,
      guide,
      catalogue,
      orgAIConfig: null,
      client: null,
    });
    expect(assignments).toHaveLength(features.length);
    expect(assignments.every(({ tier }) => tier === "rule")).toBe(true);
    expect(assignments.at(0)?.undecidedReason).toBe("no-backend");
    expect(usage.inputTokens).toBe(0);
  });

  test("asks one call per batch and decides every paragraph once", async () => {
    let calls = 0;
    const { assignments } = await assignHouseStyles({
      features,
      guide,
      catalogue,
      orgAIConfig: null,
      batchSize: 2,
      client: wireAnswering({
        chosen: (key) => (key === "p0" ? "CentredFirm" : "Bodytext1Firm"),
        confidence: 0.85,
        onCall: () => {
          calls += 1;
        },
      }),
    });
    expect(calls).toBe(3);
    expect(assignments.at(0)?.styleId).toBe("CentredFirm");
    expect(new Set(assignments.map(({ index }) => index)).size).toBe(
      features.length,
    );
  });

  test("puts only the first paragraphs to the model under a limit", async () => {
    const { assignments } = await assignHouseStyles({
      features,
      guide,
      catalogue,
      orgAIConfig: null,
      limit: 2,
      client: wireAnswering({
        chosen: () => "DefinitionFirm",
        confidence: 0.9,
      }),
    });
    expect(
      assignments.filter(({ tier }) => tier === "decision-model"),
    ).toHaveLength(2);
    expect(assignments.filter(({ tier }) => tier === "rule")).toHaveLength(
      features.length - 2,
    );
  });
});
