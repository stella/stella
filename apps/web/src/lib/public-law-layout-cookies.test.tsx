import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { PUBLIC_COUNTRIES } from "@stll/api-contract/public-country-capability";

import { useDecisionColumnPreferences } from "@/features/case-law/decision-column-preferences";
import { DEFAULT_DECISION_TABLE_LAYOUT } from "@/features/case-law/decision-column-preferences.logic";
import { DECISION_COLUMN_IDS } from "@/features/case-law/decision-columns.logic";
import { DEFAULT_STATUTE_TABLE_LAYOUT } from "@/features/statutes/statute-table-layout.logic";
import {
  decisionLayoutsCookieSchema,
  defaultPresentationPrefs,
  parseTableLayoutCookie,
  serializePresentationPrefs,
  serializeTableLayoutCookie,
  statuteLayoutsCookieSchema,
} from "@/lib/account/presentation-prefs/preferences";
import { PresentationPrefsProvider } from "@/lib/account/presentation-prefs/provider";

const DecisionTableSnapshot = () => {
  const { layout } = useDecisionColumnPreferences("CZE");
  return (
    <table
      data-hidden={layout.hidden.join(",")}
      data-summary-width={layout.sizing["summary"]}
      data-content-mode={layout.contentMode}
    />
  );
};

describe("public-law table cookies", () => {
  test("each corpus round trips independently of the small document preference cookie", () => {
    const decisionLayouts = {
      CZE: {
        ...DEFAULT_DECISION_TABLE_LAYOUT,
        hidden: ["summary"],
        sizing: { summary: 420 },
      },
    };
    const statuteLayouts = {
      CZE: { ...DEFAULT_STATUTE_TABLE_LAYOUT, pinned: ["type"] },
    };
    expect(
      parseTableLayoutCookie(
        serializeTableLayoutCookie(
          decisionLayouts,
          decisionLayoutsCookieSchema,
        ),
        decisionLayoutsCookieSchema,
      ),
    ).toEqual(decisionLayouts);
    expect(
      parseTableLayoutCookie(
        serializeTableLayoutCookie(statuteLayouts, statuteLayoutsCookieSchema),
        statuteLayoutsCookieSchema,
      ),
    ).toEqual(statuteLayouts);
    const core = serializePresentationPrefs({
      ...defaultPresentationPrefs,
      decisionLayouts,
      statuteLayouts,
    });
    expect(core).not.toContain("decisionLayouts");
    expect(core).not.toContain("statuteLayouts");
  });

  test("missing, invalid, legacy and noncanonical layouts use the default", () => {
    for (const raw of [
      undefined,
      "\ud800",
      "{",
      "null",
      "[]",
      '{"CZE":["summary"]}',
      '{"private-name":{"hidden":[]}}',
      '{"CZE":{"hidden":["private text"]}}',
      '{"CZE":{"sizing":{"summary":-1}}}',
      '{"CZE":{"order":["not-a-column"]}}',
    ]) {
      expect(
        parseTableLayoutCookie(raw, decisionLayoutsCookieSchema),
      ).toBeNull();
      expect(
        parseTableLayoutCookie(raw, statuteLayoutsCookieSchema),
      ).toBeNull();
    }
  });

  test("an oversized valid map is refused on save rather than silently forgotten", () => {
    const layouts = Object.fromEntries(
      PUBLIC_COUNTRIES.map((country) => [
        country,
        {
          ...DEFAULT_DECISION_TABLE_LAYOUT,
          hidden: [...DECISION_COLUMN_IDS],
          order: [...DECISION_COLUMN_IDS],
          pinned: [...DECISION_COLUMN_IDS],
          sizing: Object.fromEntries(
            DECISION_COLUMN_IDS.map((column) => [
              column,
              Number.MAX_SAFE_INTEGER,
            ]),
          ),
        },
      ]),
    );
    const raw = JSON.stringify(layouts);
    expect(encodeURIComponent(raw).length).toBeGreaterThan(3500);
    expect(parseTableLayoutCookie(raw, decisionLayoutsCookieSchema)).toBeNull();
    expect(() =>
      serializeTableLayoutCookie(layouts, decisionLayoutsCookieSchema),
    ).toThrow("preference cookie limit");
  });

  test("the server snapshot renders chosen columns, widths and content mode before hydration", () => {
    const decisionLayouts = parseTableLayoutCookie(
      '{"CZE":{"hidden":["summary"],"sizing":{"summary":420},"contentMode":"fit-content"}}',
      decisionLayoutsCookieSchema,
    );
    expect(decisionLayouts).not.toBeNull();
    const html = renderToStaticMarkup(
      <PresentationPrefsProvider
        initialPrefs={{
          ...defaultPresentationPrefs,
          decisionLayouts: decisionLayouts ?? {},
        }}
      >
        <DecisionTableSnapshot />
      </PresentationPrefsProvider>,
    );
    expect(html).toContain('data-hidden="summary"');
    expect(html).toContain('data-summary-width="420"');
    expect(html).toContain('data-content-mode="fit-content"');
  });
});
