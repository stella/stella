import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { IntlProvider } from "use-intl";

import { DECISION_TYPE_KINDS } from "@stll/api-contract/case-law-decision-types";

import { FACET_SECTION_LIMIT } from "@/components/public-law-table/public-law-facets.logic";
import { DecisionTypeFacetSection } from "@/features/case-law/components/decision-filter-popover";
import { FormattingProvider } from "@/i18n/formatting-context";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const LANGS_DIR = new URL("../../../i18n/langs/", import.meta.url);

/** Every locale the web ships: each catalog in the langs directory. */
const LOCALES = readdirSync(LANGS_DIR)
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.slice(0, -".json".length))
  .toSorted();

const catalog = async (locale: string): Promise<Record<string, unknown>> => {
  const loaded: unknown = (
    await import(new URL(`${locale}.json`, LANGS_DIR).href)
  ).default;
  return isRecord(loaded) ? loaded : {};
};

const decisionTypeLabels = (messages: Record<string, unknown>) => {
  const caseLaw = messages["caseLaw"];
  const labels = isRecord(caseLaw) ? caseLaw["decisionTypes"] : undefined;
  return isRecord(labels) ? labels : {};
};

/** The text a reader sees: the markup without its tags and attributes. */
const visibleText = (node: ReactNode, locale: string, messages: object) =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={messages} timeZone="UTC">
      <FormattingProvider locale={locale} timeZone="UTC">
        {node}
      </FormattingProvider>
    </IntlProvider>,
  ).replaceAll(/<[^>]*>/gu, "\n");

const ALL_KINDS = DECISION_TYPE_KINDS.map((value) => ({ value, count: 1 }));

describe("the type facet draws canonical labels, never a raw value", () => {
  test("the web ships locale catalogs to check", () => {
    expect(LOCALES).toContain("en");
    expect(LOCALES.length).toBeGreaterThan(1);
  });

  for (const locale of LOCALES) {
    test(`every kind has a label in ${locale}, and only labels are drawn`, async () => {
      const messages = await catalog(locale);
      const labels = decisionTypeLabels(messages);
      // The section shows a scannable head before "Show all", so every kind
      // is drawn in a section of its own size.
      const text = Array.from(
        { length: Math.ceil(ALL_KINDS.length / FACET_SECTION_LIMIT) },
        (_, page) =>
          visibleText(
            <DecisionTypeFacetSection
              buckets={ALL_KINDS.slice(
                page * FACET_SECTION_LIMIT,
                (page + 1) * FACET_SECTION_LIMIT,
              )}
              onSelect={() => undefined}
              selectedValue={undefined}
            />,
            locale,
            messages,
          ),
      ).join("\n");
      const lines = new Set(text.split("\n").map((line) => line.trim()));

      for (const kind of DECISION_TYPE_KINDS) {
        const label = labels[kind];
        expect(typeof label === "string" && label.trim().length > 0).toBe(true);
        expect(lines.has(String(label))).toBe(true);
        // A raw key never reaches the reader, in any casing.
        expect(lines.has(kind)).toBe(false);
      }
      expect(text).not.toMatch(/[a-z]_[a-z]/u);
    });
  }

  test("a selected kind the page reports no bucket for is still drawn by its label", async () => {
    const messages = await catalog("cs");
    const text = visibleText(
      <DecisionTypeFacetSection
        buckets={[]}
        onSelect={() => undefined}
        selectedValue="ministry_of_justice_decision"
      />,
      "cs",
      messages,
    );

    expect(text).toContain("Rozhodnutí ministerstva spravedlnosti");
    expect(text).not.toContain("ministry_of_justice_decision");
  });
});
