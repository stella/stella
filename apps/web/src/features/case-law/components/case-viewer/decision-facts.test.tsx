import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { DetailsItem } from "@stll/ui/details-grid";

import { DecisionFacts } from "@/features/case-law/components/case-viewer/decision-facts";
import { DECISION_FACT_KINDS } from "@/features/case-law/components/case-viewer/decision-facts.logic";
import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";

const render = (children: ReactNode, locale = "en") =>
  renderToStaticMarkup(
    <IntlProvider
      locale={locale}
      messages={locale === "ar" ? ar : en}
      timeZone="UTC"
    >
      {children}
    </IntlProvider>,
  );

const courtValue = "Synthetic court value";
const dateValue = "Synthetic date value";
const ecliValue = "ECLI:SYNTHETIC:EXAMPLE";

const publisher = {
  decisionType: "synthetic type",
  judges: [],
  metadata: {},
  source: { name: "Synthetic publisher" },
  sourceUrl: "https://example.org/synthetic-decision",
};

describe("decision details share one fact grid", () => {
  test("core identifiers and publisher facts have one semantic list and shared label tracks", () => {
    const markup = render(
      <DecisionFacts
        {...publisher}
        className="mb-0"
        facts={DECISION_FACT_KINDS}
      >
        <DetailsItem label="Synthetic court">{courtValue}</DetailsItem>
        <DetailsItem label="Synthetic date">{dateValue}</DetailsItem>
        <DetailsItem label="ECLI" span="wide">
          {ecliValue}
        </DetailsItem>
      </DecisionFacts>,
    );
    expect(markup.match(/<dl\b/gu)).toHaveLength(1);
    expect(markup.match(/<dt\b/gu)).toHaveLength(5);
    expect(markup.match(/<dd\b/gu)).toHaveLength(5);
    expect(markup).toContain("Synthetic court value");
    expect(markup).toContain("ECLI:SYNTHETIC:EXAMPLE");
    expect(markup).toContain("synthetic type");
    expect(markup).toContain("Synthetic publisher");
    expect(markup).toContain("col-span-full");
    expect(markup).not.toContain("grid-cols-[auto_minmax(0,1fr)]");
  });

  test("core identifiers remain visible when the publisher has no optional facts", () => {
    const empty = { ...publisher, decisionType: null, sourceUrl: null };
    expect(
      render(<DecisionFacts {...empty} facts={DECISION_FACT_KINDS} />),
    ).toBe("");
    const markup = render(
      <DecisionFacts {...empty} facts={DECISION_FACT_KINDS}>
        <DetailsItem label="Synthetic court">{courtValue}</DetailsItem>
      </DecisionFacts>,
    );
    expect(markup.match(/<dt\b/gu)).toHaveLength(1);
    expect(markup).toContain("Synthetic court value");
  });

  test("publisher labels use Arabic translations in an RTL surface", () => {
    const markup = render(
      <div dir="rtl">
        <DecisionFacts {...publisher} facts={["decisionType", "source"]} />
      </div>,
      "ar",
    );
    expect(markup).toContain('dir="rtl"');
    expect(markup).toContain(ar.common.type);
    expect(markup).toContain(ar.common.source);
    expect(markup).not.toContain("text-left");
    expect(markup).not.toContain("text-right");
  });
});
