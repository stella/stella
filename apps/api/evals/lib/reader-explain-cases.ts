/** Public corpus cases. Publisher paragraph numbers are locators, never invented AST ids. */
export const SCHREMS_I = "ECLI:EU:C:2015:650";
export const SCHREMS_II = "ECLI:EU:C:2020:559";

export type ExplainEvalCase = {
  id: string;
  direction: "cited" | "citing";
  selection: { ecli: string; publisherParagraph: number };
  expectedCitation: { ecli: string; publisherParagraph: number };
  instruction: string;
  expectedInsight: string;
};

export const readerExplainCases = [
  {
    id: "supervisory-referral",
    direction: "cited",
    selection: { ecli: SCHREMS_II, publisherParagraph: 57 },
    expectedCitation: { ecli: SCHREMS_I, publisherParagraph: 65 },
    instruction:
      "Explain why a supervisory authority must go through a court to contest the standard clauses.",
    expectedInsight:
      "Distinguish investigation powers from the Court of Justice’s exclusive power to invalidate an EU act.",
  },
  {
    id: "commercial-transfer-scope",
    direction: "cited",
    selection: { ecli: SCHREMS_II, publisherParagraph: 83 },
    expectedCitation: { ecli: SCHREMS_I, publisherParagraph: 45 },
    instruction:
      "Explain why a commercial transfer remains within data protection law despite national security processing after transfer.",
    expectedInsight:
      "Apply the predecessor’s commercial-transfer rule to GDPR rather than treating national security as excluding the whole transfer.",
  },
  {
    id: "essential-equivalence",
    direction: "cited",
    selection: { ecli: SCHREMS_II, publisherParagraph: 94 },
    expectedCitation: { ecli: SCHREMS_I, publisherParagraph: 73 },
    instruction:
      "Explain what essentially equivalent protection requires from a third country.",
    expectedInsight:
      "Equivalence concerns effective fundamental-rights protection, not identical legal institutions.",
  },
  {
    id: "complaint-diligence",
    direction: "cited",
    selection: { ecli: SCHREMS_II, publisherParagraph: 109 },
    expectedCitation: { ecli: SCHREMS_I, publisherParagraph: 63 },
    instruction:
      "Explain the supervisory authority’s duty when a person challenges protection after transfer.",
    expectedInsight:
      "The adequacy decision does not replace diligent examination of the individual complaint.",
  },
  {
    id: "binding-adequacy",
    direction: "cited",
    selection: { ecli: SCHREMS_II, publisherParagraph: 117 },
    expectedCitation: { ecli: SCHREMS_I, publisherParagraph: 51 },
    instruction:
      "Explain the binding effect of an adequacy decision and its limits.",
    expectedInsight:
      "Separate the binding decision from the authority’s continuing investigation and referral powers.",
  },
  {
    id: "complaint-survives-adequacy",
    direction: "cited",
    selection: { ecli: SCHREMS_II, publisherParagraph: 119 },
    expectedCitation: { ecli: SCHREMS_I, publisherParagraph: 53 },
    instruction:
      "Explain why an adequacy decision does not extinguish a data subject’s complaint.",
    expectedInsight:
      "The predecessor protects independent supervisory powers despite a binding adequacy decision.",
  },
  {
    id: "effective-remedy",
    direction: "cited",
    selection: { ecli: SCHREMS_II, publisherParagraph: 187 },
    expectedCitation: { ecli: SCHREMS_I, publisherParagraph: 95 },
    instruction:
      "Explain why access, correction and erasure remedies matter for transfer protection.",
    expectedInsight:
      "The absence of an effective judicial remedy affects the essence of Article 47, not just procedural convenience.",
  },
  {
    id: "later-binding-adequacy",
    direction: "citing",
    selection: { ecli: SCHREMS_I, publisherParagraph: 51 },
    expectedCitation: { ecli: SCHREMS_II, publisherParagraph: 117 },
    instruction:
      "Explain how later GDPR case law applies this binding-effect rule.",
    expectedInsight:
      "The later decision carries the rule from Directive 95/46 into Article 45 GDPR.",
  },
  {
    id: "later-invalidity-route",
    direction: "citing",
    selection: { ecli: SCHREMS_I, publisherParagraph: 52 },
    expectedCitation: { ecli: SCHREMS_II, publisherParagraph: 118 },
    instruction:
      "Explain whether a supervisory authority may itself invalidate adequacy after later case law.",
    expectedInsight:
      "The later case preserves the Court’s invalidation role and distinguishes investigation from prohibition contrary to adequacy.",
  },
  {
    id: "later-supervisory-powers",
    direction: "citing",
    selection: { ecli: SCHREMS_I, publisherParagraph: 53 },
    expectedCitation: { ecli: SCHREMS_II, publisherParagraph: 119 },
    instruction:
      "Explain whether this protection of supervisory powers survives the GDPR transition.",
    expectedInsight:
      "The later decision expressly applies the earlier principle to GDPR Articles 51 and 57.",
  },
] as const satisfies readonly ExplainEvalCase[];
