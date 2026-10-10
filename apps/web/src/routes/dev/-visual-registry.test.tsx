import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";
import * as v from "valibot";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";

import { railCourtAbbreviation } from "@/features/case-law/components/case-decision-rail-icon.logic";
import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";

import { CHAT_HISTORY_DECISION_FIXTURES } from "./-components/chat-history-decision-fixtures";
import { ChatHistoryDecisionPlayground } from "./-components/chat-history-decision-playground";
import { visualRegistry } from "./-visual-metadata";
import { FixtureSection, visualSearchSchema } from "./-visual-registry";

describe("registered visual fixtures", () => {
  test("chat history covers every court tier with unique capture anchors", () => {
    expect(visualRegistry["chat-history-decision"].layout).toBe("plain");
    const fixtures = CHAT_HISTORY_DECISION_FIXTURES;
    expect(new Set(fixtures.map(({ state }) => state)).size).toBe(
      fixtures.length,
    );
    const tiers = new Set(
      fixtures.flatMap(({ decision }) =>
        decision?.type === "present" ? [decision.badge.courtTier] : [],
      ),
    );
    expect(tiers).toEqual(new Set(COURT_TIER_LABELS));
  });

  for (const [locale, messages] of Object.entries({ en, ar })) {
    test(`chat history renders every anchored state in ${locale}`, () => {
      const html = renderToStaticMarkup(
        <IntlProvider locale={locale} messages={messages} timeZone="UTC">
          <ChatHistoryDecisionPlayground />
        </IntlProvider>,
      );
      expect(html).toContain('data-playground-section="chat-history-decision"');
      for (const { state, decision } of CHAT_HISTORY_DECISION_FIXTURES) {
        const row = new RegExp(
          `<li[^>]*data-playground-state="${state}"[^>]*>(.*?)</li>`,
          "u",
        )
          .exec(html)
          ?.at(1);
        expect(row).toBeDefined();
        if (decision?.type === "present") {
          expect(row).toContain(decision.badge.caseNumber);
          expect(row).toContain(decision.badge.court);
          const abbreviation = railCourtAbbreviation(
            decision.badge.courtAbbreviation,
          );
          if (abbreviation === null) {
            expect(row).not.toContain('data-slot="court-badge"');
          } else {
            expect(row).toContain('data-slot="court-badge"');
            expect(row).toContain(`>${abbreviation}<`);
          }
          if (decision.badge.decisionDate === null) {
            expect(row).not.toContain("·");
          }
        } else {
          expect(row).not.toContain('data-slot="court-badge"');
        }
      }
    });
  }

  for (const [name, entry] of Object.entries(visualRegistry)) {
    test(`${name} is selectable and renders its fixture label`, () => {
      const { visual } = v.parse(visualSearchSchema, { visual: name });
      expect(visual === name).toBe(true);
      if (visual === undefined) {
        throw new TypeError("A registered fixture must have a visual name");
      }

      const html = renderToStaticMarkup(
        <FixtureSection visual={visual}>
          <div data-fixture-content="true" />
        </FixtureSection>,
      );
      expect(html).toContain(`data-playground-section="fixture:${name}"`);
      expect(html).toContain(`<header`);
      expect(html).toContain(`Fixture: ${entry.label}</header>`);
      expect(html).toContain('data-fixture-content="true"');
    });
  }

  test("rejects unknown names and inherited object keys", () => {
    for (const visual of ["unknown", "toString", "__proto__", 1, null]) {
      expect(v.safeParse(visualSearchSchema, { visual }).success).toBe(false);
    }
    expect(v.parse(visualSearchSchema, {})).toEqual({});
  });
});
