import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { FormattingProvider } from "@/i18n/formatting-context";
import en from "@/i18n/langs/en.json";
import { toSafeId } from "@/lib/safe-id";

import {
  ChatThreadDecisionLabel,
  drawableChatThreadDecision,
} from "./chat-thread-decision";
import type { ChatThreadDecision } from "./chat-thread-decision";

const DECISION: ChatThreadDecision = {
  caseNumber: "25 Cdo 1234/2021",
  country: "CZE",
  court: "Nejvyšší soud",
  courtAbbreviation: "NS",
  courtTier: "supreme",
  decisionDate: "2021-03-12",
  id: toSafeId<"caseLawDecision">("00000000-0000-0000-0000-000000000006"),
  language: "cs",
  languageAlternates: [],
  slug: "open-case",
};

const render = (decision: ChatThreadDecision) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={en} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <ChatThreadDecisionLabel decision={decision} />
      </FormattingProvider>
    </IntlProvider>,
  );

describe("chat thread decision label", () => {
  test("draws the court chip, the case number and the decision date", () => {
    const html = render(DECISION);

    expect(html).toContain('data-slot="court-badge"');
    expect(html).toContain("leading-3.5");
    expect(html).not.toContain("py-0.5");
    expect(html).toContain(">NS<");
    expect(html).toContain("25 Cdo 1234/2021");
    expect(html).toContain("Mar 12, 2021");
  });

  test("keeps the court's name beside its chip for hover and screen readers", () => {
    const html = render(DECISION);

    expect(html).toContain('title="Nejvyšší soud"');
    expect(html).toContain('<span class="sr-only">Nejvyšší soud</span>');
  });

  test.each([null, "", "  ", "Kúria", "SCOTUS"])(
    "writes the court out when %j has no inline chip to draw",
    (courtAbbreviation) => {
      const html = render({ ...DECISION, courtAbbreviation });

      expect(html).not.toContain('data-slot="court-badge"');
      expect(html).toContain("Nejvyšší soud");
    },
  );

  test("trims the corpus abbreviation before drawing the shared identity badge", () => {
    const html = render({ ...DECISION, courtAbbreviation: " CJEU " });

    expect(html).toContain('data-slot="document-identity-badge"');
    expect(html).toContain('data-kind="decision"');
    expect(html).toContain(">CJEU<");
  });

  test("leaves the date out when the decision states none", () => {
    const html = render({ ...DECISION, decisionDate: null });

    expect(html).toContain("25 Cdo 1234/2021");
    expect(html).not.toContain("·");
  });
});

describe("drawable chat thread decision", () => {
  test("draws a decision the corpus served", () => {
    expect(
      drawableChatThreadDecision({
        decision: { type: "present", badge: DECISION },
      }),
    ).toBe(DECISION);
  });

  test("lists a chat whose decision could not be read as an ordinary one", () => {
    expect(
      drawableChatThreadDecision({ decision: { type: "unavailable" } }),
    ).toBeNull();
    expect(drawableChatThreadDecision({ decision: null })).toBeNull();
  });
});
