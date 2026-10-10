import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { Decision } from "@/features/case-law/components/decision-cells";
import { DecisionPassageCitation } from "@/features/case-law/components/decision-passage-citation";
import { FormattingProvider } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/en.json";

const decision = {
  id: "019a0000-0000-7000-8000-000000000301",
  caseNumber: "25 Cdo 627/2022",
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  country: "CZE",
  court: "Nejvyšší soud",
  courtAbbreviation: "NS",
  decisionDate: "2023-01-06",
  decisionType: "Rozsudek",
  ecli: null,
  language: "cs",
  languageAlternates: [],
  slug: "synthetic-research-decision",
  sourceUrl:
    "https://court.example.invalid/decisions/synthetic-research-decision",
  headnote: { type: "absent", reason: "not_published" },
  citationCount: 0,
} satisfies Decision;

const excerpt =
  "The court relied on the established facts and all the documentary evidence submitted.";

test("research provenance keeps the complete passage before its court chip", () => {
  const markup = renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <DecisionPassageCitation
          decision={decision}
          citation={{ kind: "decision-passage", anchorId: "p-12", excerpt }}
          onOpen={() => undefined}
        />
        <DecisionPassageCitation
          decision={decision}
          citation={{ kind: "decision-passage", anchorId: "p-13", excerpt }}
          onOpen={() => undefined}
        />
      </FormattingProvider>
    </IntlProvider>,
  );
  const firstChip = markup.indexOf("data-decision-citation=");
  expect(firstChip).toBeGreaterThan(0);
  expect(markup.slice(0, firstChip)).toContain(excerpt);
  expect(markup).not.toContain("…");
  expect(markup.match(/data-citation-presentation="compact"/gu)).toHaveLength(
    2,
  );
  expect(markup).toContain("#p-12");
  expect(markup).toContain("#p-13");
});
