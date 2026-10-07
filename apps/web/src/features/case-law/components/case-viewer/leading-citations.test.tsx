import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type {
  CitedDecisionAddress,
  DecisionCitationSummary,
} from "@/features/case-law/citation-treatment";
import { LeadingCitations } from "@/features/case-law/components/case-viewer/leading-citations";
import { decisionCitationSummaryOptions } from "@/features/case-law/queries/citations";
import { FormattingProvider } from "@/i18n/formatting-context";
import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";
import { toSafeId } from "@/lib/safe-id";

const decision = {
  caseNumber: "Pl. ÚS 1/2026",
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  country: "CZ",
  court: "Ústavní soud",
  decisionDate: "2026-01-01",
  decisionType: null,
  ecli: null,
  id: toSafeId<"caseLawDecision">("00000000-0000-4000-8000-000000000001"),
  language: "cs",
  languageAlternates: [],
  slug: null,
} as const satisfies CitedDecisionAddress;

const counts = {
  mixed: 0,
  negative: 0,
  neutral: 0,
  positive: 0,
  supportive: 0,
  unclassified: 0,
};

const render = (summary: DecisionCitationSummary, locale: "en" | "ar") => {
  const messages = locale === "en" ? en : ar;
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  client.setQueryData(
    decisionCitationSummaryOptions(decision.id).queryKey,
    summary,
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IntlProvider locale={locale} messages={messages} timeZone="UTC">
        <FormattingProvider
          locale={locale === "ar" ? "ar-u-nu-arab" : locale}
          timeZone="UTC"
        >
          <LeadingCitations decision={decision} decisionId={decision.id} />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

describe("partial citation summaries", () => {
  for (const locale of ["en", "ar"] as const) {
    const messages = locale === "en" ? en : ar;
    for (const direction of ["incoming", "outgoing"] as const) {
      test(`${locale}: capped ${direction} keeps its lower bound and partial notice visible`, () => {
        for (const count of [0, 2048]) {
          const capped = {
            incoming: direction === "incoming",
            outgoing: direction === "outgoing",
          };
          const summary = {
            precision: {
              status: "bounded",
              capped,
            },
            incoming: {
              ...counts,
              positive: direction === "incoming" ? count : 0,
            },
            incomingByYear: [],
            outgoing: {
              ...counts,
              positive: direction === "outgoing" ? count : 0,
            },
          } satisfies DecisionCitationSummary;
          const markup = render(summary, locale);
          const numerals =
            locale === "en"
              ? (["0", "2,048"] as const)
              : (["٠", "٢٬٠٤٨"] as const);
          const number = count === 0 ? numerals[0] : numerals[1];
          expect(markup).toContain(`>${number}+<`);
          expect(markup).toContain(messages.caseLaw.citation.partialSummary);
          expect(markup).toContain(
            direction === "incoming"
              ? messages.caseLaw.viewer.citedBy
              : messages.caseLaw.viewer.cites,
          );
          expect(
            render(
              {
                ...summary,
                precision: { status: "exact" },
              },
              locale,
            ),
          ).not.toContain(messages.caseLaw.citation.partialSummary);
        }
      });
    }
  }
});
