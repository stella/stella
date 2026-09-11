import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import {
  TEXT_ABSENCE_REASON,
  TEXT_FIELD_TYPE,
} from "@stll/api-contract/case-law-text-field";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { DecisionText } from "@/features/case-law/components/case-viewer/decision-text";
import { editorialSupplementBlocks } from "@/features/case-law/components/case-viewer/decision-text.logic";
import messages from "@/i18n/langs/en.json";

const ast = {
  blocks: [
    {
      anchorId: "p-1",
      id: "body",
      inlines: [{ text: "Court text.", type: "text" }],
      plainText: "Court text.",
      type: "paragraph",
    },
  ],
  metadata: {
    caseNumber: "1 As 1/2026",
    court: "Test court",
    decisionDate: null,
    decisionType: "Judgment",
    ecli: null,
    keywords: [],
    statutes: [],
  },
  source: { documentId: "1", printUrl: "", system: "test", webUrl: "" },
  version: 1,
} as const satisfies DocumentAst;

const renderDecision = (abstract: string): string =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <DecisionText
        activeMatchIndex={-1}
        decision={{
          caseNumber: "1 As 1/2026",
          court: "Test court",
          documentAst: ast,
          fulltext: null,
          language: "cs",
          textFields: {
            abstract: { text: abstract, type: TEXT_FIELD_TYPE.PRESENT },
            headnote: {
              reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
              type: TEXT_FIELD_TYPE.ABSENT,
            },
            legalSentence: {
              reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
              type: TEXT_FIELD_TYPE.ABSENT,
            },
            summary: {
              reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
              type: TEXT_FIELD_TYPE.ABSENT,
            },
          },
        }}
        searchQuery=""
      />
    </IntlProvider>,
  );

describe("editorial legal text annotations", () => {
  test("every rendered source block has a stable selection anchor", () => {
    const abstract =
      "Analytická právní věta\n\nText with http://example.test/source.";
    const markup = renderDecision(abstract);

    for (const block of editorialSupplementBlocks(abstract)) {
      expect(markup).toContain(
        `data-anchor="supplement-abstract:${String(block.start)}"`,
      );
    }
    expect(markup).toContain('href="http://example.test/source"');
    expect(markup).not.toContain(messages.caseLaw.viewer.provisionsCited);
  });
});
