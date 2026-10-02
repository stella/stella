import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";
import { IntlProvider } from "use-intl";
import * as v from "valibot";

import { PUBLIC_DECISION_MATCH } from "@/features/case-law/public-decision-match";
import { loadLocaleMessages, supportedLanguages } from "@/i18n/i18n-store";
import { publicDecisionSearchSchema } from "@/routes/law/-case-detail.logic";
import { PublicDecisionFileNote } from "@/routes/law/-components/public-decision-file-note";

test("the case-file note renders a translated sentence in every locale", async () => {
  const sentences = new Set<string>();
  for (const locale of supportedLanguages) {
    const messages = await loadLocaleMessages(locale);
    const markup = renderToStaticMarkup(
      <IntlProvider locale={locale} messages={messages} timeZone="UTC">
        <PublicDecisionFileNote />
      </IntlProvider>,
    );
    expect(markup).toContain('role="note"');
    expect(markup).not.toContain("caseLaw.viewer.caseFileMayHoldOthers");
    sentences.add(markup);
  }
  // No locale falls back to another's sentence.
  expect(sentences.size).toBe(supportedLanguages.length);
});

test("the English note says the file may hold more, never that this is the only one", async () => {
  const messages = await loadLocaleMessages("en");
  const markup = renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <PublicDecisionFileNote />
    </IntlProvider>,
  );
  expect(markup).toContain("may contain other decisions");
  expect(markup).not.toMatch(/\bonly\b/u);
});

test("the decision route reads the match marker and drops an unknown one", () => {
  expect(
    v.parse(publicDecisionSearchSchema, {
      match: PUBLIC_DECISION_MATCH.FILE_INCOMPLETE,
    }).match,
  ).toBe(PUBLIC_DECISION_MATCH.FILE_INCOMPLETE);
  expect(
    v.parse(publicDecisionSearchSchema, { match: "unique" }).match,
  ).toBeUndefined();
  expect(v.parse(publicDecisionSearchSchema, {}).match).toBeUndefined();
});
