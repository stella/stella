import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { queryHighlightTokens } from "@stll/decision-reader/query-marks";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { FindHighlightScope } from "@/components/workspaces/table/find-highlight";
import type { TableFindHighlight } from "@/components/workspaces/table/find-highlight";
import type {
  Decision,
  DecisionRenderContext,
} from "@/features/case-law/components/decision-cells";
import { renderDecisionCell } from "@/features/case-law/decision-columns";
import messages from "@/i18n/langs/en.json";

const decision = {
  id: "decision",
  caseNumber: "Pl. ÚS 1/26",
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  slug: null,
  ecli: null,
  court: "Constitutional Court",
  country: "CZE",
  language: "cs",
  languageAlternates: [],
  decisionDate: "2026-01-01",
  decisionType: "nález",
  decisionTypeKind: "finding",
  headnote: { type: "absent", reason: "not_published" },
  citationCount: 0,
} as const satisfies Decision;

const context = {
  identityLineFields: [],
  queryTokens: queryHighlightTokens(""),
  searchQuery: undefined,
  contentMode: "tight",
  expandedHeadnoteIds: new Set<string>(),
  onToggleHeadnote: () => undefined,
} satisfies DecisionRenderContext;

const typeCell = (
  row: Decision,
  highlight: TableFindHighlight | null = null,
): string =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FindHighlightScope highlight={highlight}>
        {renderDecisionCell({ column: "type", decision: row, context })}
      </FindHighlightScope>
    </IntlProvider>,
  );

describe("the decision type column", () => {
  test("shows the localized normalized kind and keeps the publisher wording", () => {
    const markup = typeCell(decision);
    expect(markup).toContain("Finding");
    expect(markup).toContain("nález");
  });

  test("highlights a table search match in the publisher wording", () => {
    const markup = typeCell(decision, {
      columnIds: new Set(["type"]),
      matchesName: false,
      term: "nález",
    });
    expect(markup).toContain("<mark");
    expect(markup).toContain(">nález</mark>");
  });

  test("shows the publisher wording when the API could not classify it", () => {
    expect(
      typeCell({
        ...decision,
        decisionType: "atypický akt",
        decisionTypeKind: null,
      }),
    ).toContain("atypický akt");
  });
});
