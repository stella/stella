import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";
import * as v from "valibot";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";

import { FormattingProvider } from "@/i18n/formatting-context";
import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";
import hu from "@/i18n/langs/hu.json";

import { CHAT_HISTORY_DECISION_FIXTURES } from "./-components/chat-history-decision-fixtures";
import { ChatHistoryDecisionPlayground } from "./-components/chat-history-decision-playground";
import { HungarianDecisionPlayground } from "./-components/hungarian-decision-playground";
import { playbookEditorStates, visualRegistry } from "./-visual-metadata";
import { FixtureSection, visualSearchSchema } from "./-visual-registry";

describe("registered visual fixtures", () => {
  for (const [locale, messages] of Object.entries({ hu, ar })) {
    test(`Hungarian decision renders original typography in ${locale}`, () => {
      expect(visualRegistry["hungarian-decision"].layout).toBe("plain");
      const html = renderToStaticMarkup(
        <IntlProvider locale={locale} messages={messages} timeZone="UTC">
          <FormattingProvider
            locale={locale === "ar" ? "ar" : "hu"}
            timeZone="UTC"
          >
            <HungarianDecisionPlayground />
          </FormattingProvider>
        </IntlProvider>,
      );
      expect(html).toContain('data-playground-section="hungarian-decision"');
      expect(html).toContain('lang="hu" dir="ltr"');
      expect(html).toContain("Kúria, Pfv.21.123/2019/5., 2019. március 21.");
      expect(html).toContain("„teljesítés”");
      expect(html).toContain('data-anchor="p-3"');
    });
  }

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
          const abbreviation = decision.badge.courtAbbreviation?.trim();
          if (!abbreviation || abbreviation.length > 4) {
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

  test("long paste is registered as a standalone chat fixture", () => {
    expect(v.parse(visualSearchSchema, { visual: "chat-long-paste" })).toEqual({
      visual: "chat-long-paste",
    });
    expect(visualRegistry["chat-long-paste"]).toEqual({
      label: "Chat long paste",
      layout: "plain",
    });
  });

  test("registers the playbook lifecycle capture states", () => {
    expect(visualRegistry["playbook-editor"].layout).toBe("plain");
    expect(playbookEditorStates).toEqual(["rejected", "editing", "parked"]);
  });

  test("drops unknown names and inherited object keys", () => {
    for (const visual of ["unknown", "toString", "__proto__", 1, null]) {
      expect(v.parse(visualSearchSchema, { visual })).toEqual({});
    }
    expect(v.parse(visualSearchSchema, {})).toEqual({});
  });
});
