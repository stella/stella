import type { decisionProvisionsInfiniteOptions } from "@/features/case-law/queries/provisions";

type DecisionProvisionsQueryFn = NonNullable<
  ReturnType<typeof decisionProvisionsInfiniteOptions>["queryFn"]
>;
type DecisionProvision = Awaited<
  ReturnType<DecisionProvisionsQueryFn>
>["items"][number];

export const provision = (
  overrides: Partial<DecisionProvision>,
): DecisionProvision => ({
  anchor: "s265b",
  confidence: 0.9,
  jurisdiction: "CZE",
  letter: null,
  openEnded: false,
  point: null,
  section: 265,
  sectionSuffix: "b",
  sentence: null,
  sentenceText: "Dovolání se opírá o § 265b odst. 1 trestního řádu.",
  spanEnd: 60,
  spanStart: 40,
  subsection: "1",
  unit: "section",
  workCollection: "Sb.",
  workEli: "/eli/cz/sb/1961/141",
  workIdentifier: "141/1961",
  workNumber: 141,
  workSource: "number",
  workYear: 1961,
  versionValidFrom: null,
  versionBasis: { type: "inferred", kind: "decision_date" },
  inferredVersionCandidate: {
    type: "inferred",
    kind: "decision_date",
    versionValidFrom: null,
  },
  previewKey: null,
  spanRole: null,
  printPieceId: null,
  printStart: null,
  printEnd: null,
  printText: null,
  namePieceId: null,
  nameStart: null,
  nameEnd: null,
  nameText: null,
  selection: null,
  printedWorkIdentifier: null,
  targetDocumentId: null,
  targetStatus: null,
  ...overrides,
});
