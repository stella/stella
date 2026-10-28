import {
  TEXT_ABSENCE_REASON,
  TEXT_FIELD_TYPE,
} from "@stll/api-contract/case-law-text-field";
import type { ReaderDecision } from "@stll/decision-reader/reader-types";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { WebDecisionReader } from "@/components/legal-reader/web-decision-reader";
import { formatDecisionCitation } from "@/features/case-law/citation-format";

export const HungarianDecisionPlayground = () => (
  <section
    className="mx-auto w-full max-w-3xl p-4"
    data-playground-section="hungarian-decision"
    lang="hu"
    dir="ltr"
  >
    <h1 className="mb-8 text-xl font-medium">
      <bdi>
        {formatDecisionCitation({
          ...HUNGARIAN_DECISION_FIXTURE,
          decisionDate: ast.metadata.decisionDate,
          decisionType: ast.metadata.decisionType,
          ecli: null,
          name: null,
          paragraph: null,
          pincite: null,
        })}
      </bdi>
    </h1>
    <WebDecisionReader
      decision={HUNGARIAN_DECISION_FIXTURE}
      decisionId={HUNGARIAN_DECISION_FIXTURE.id}
      surface="development"
    />
  </section>
);

const absent = {
  reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
  type: TEXT_FIELD_TYPE.ABSENT,
} as const;

const text = [
  "A bíróság a bemutatott iratok alapján vizsgálta a kérelmet.",
  "Az iratban szereplő „teljesítés” kifejezés értelmét a szöveg összefüggése határozza meg.",
  "A felek nyilatkozatait és a rendelkezésre álló iratokat együttesen kell értékelni.",
];

const ast = {
  blocks: text.map((plainText, index) => ({
    anchorId: `p-${String(index + 1)}`,
    id: `hu-fixture-${String(index + 1)}`,
    inlines: [{ text: plainText, type: "text" }],
    plainText,
    type: "paragraph",
  })),
  metadata: {
    caseNumber: "Pfv.21.123/2019/5.",
    court: "Kúria",
    decisionDate: "2019-03-21",
    decisionType: "ítélet",
    ecli: null,
    keywords: [],
    statutes: [],
  },
  source: {
    documentId: "hu-synthetic",
    printUrl: "",
    system: "fixture",
    webUrl: "",
  },
  version: 1,
} satisfies DocumentAst;

/** Synthetic text: no real parties, facts or judicial holding. */
const HUNGARIAN_DECISION_FIXTURE = {
  caseNumber: ast.metadata.caseNumber,
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  country: "HUN",
  court: ast.metadata.court,
  courtAbbreviation: "Kúria",
  courtTier: "supreme",
  documentAst: ast,
  documentPending: false,
  documentReadFailed: false,
  textState: null,
  documentUnavailable: false,
  fulltext: null,
  id: "00000000-0000-4000-8000-000000000891",
  judges: [],
  language: "hu",
  sourceAttributionUrl: null,
  textFields: {
    abstract: absent,
    headnote: absent,
    legalSentence: absent,
    summary: absent,
  },
} satisfies ReaderDecision;
