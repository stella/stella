import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { DecisionAnalysis } from "@stll/legal-ast/analysis";
import type { Block } from "@stll/legal-ast/document-ast";

import english from "@/i18n/langs/en.json";
import { noopAnalytics } from "@/lib/analytics/noop";
import type { Analytics } from "@/lib/analytics/types";
import { unregisterDomEnvironment } from "@/test-dom-environment";

import { PARAGRAPH_PREVIEW_CHARACTER_LIMIT } from "./paragraph-reference.logic";

GlobalRegistrator.register({ url: "https://app.example.test/law" });
const { cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { WebReaderPresentationProvider } =
  await import("@/components/legal-reader/web-reader-presentation");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AnalyticsContext } = await import("@/lib/analytics/provider");
const { AiHeadnotes } = await import("./analysis/ai-headnotes");

afterEach(cleanup);
afterAll(unregisterDomEnvironment);

const NINE = "The court of appeal did not address the objection.";
const TEN = "That omission breached the right to a fair trial.";
const ELEVEN = "The contested judgment is therefore annulled.";

const paragraphNine = {
  id: "nine",
  anchorId: "p-9",
  type: "paragraph",
  number: 9,
  inlines: [],
  plainText: NINE,
} satisfies Block;

const fixtureBlocks = [
  paragraphNine,
  {
    id: "ten",
    anchorId: "p-10",
    type: "paragraph",
    number: 10,
    inlines: [],
    plainText: TEN,
  },
  {
    id: "eleven",
    anchorId: "p-11",
    type: "paragraph",
    number: 11,
    inlines: [],
    plainText: ELEVEN,
  },
] satisfies Block[];

const analysisCiting = (
  anchors: { startAnchorId: string; endAnchorId: string }[],
) =>
  ({
    version: 4,
    generatedAt: "2026-10-18T00:00:00Z",
    model: "fixture-model",
    inputFingerprint: `fixture-${anchors.map((anchor) => anchor.endAnchorId).join("-")}`,
    tree: [],
    holding: {
      spans: [{ text: "The complaint is well founded.", anchors }],
      language: "en",
    },
    abstract: {
      spans: [{ text: "The court annulled the judgment.", anchors: [] }],
      language: "en",
    },
    topics: [],
  }) satisfies DecisionAnalysis;

type RenderHeadnotesOptions = {
  analysis: DecisionAnalysis;
  analytics?: Analytics;
  blocks?: Block[];
};

const renderHeadnotes = ({
  analysis,
  analytics = noopAnalytics,
  blocks = fixtureBlocks,
}: RenderHeadnotesOptions) => {
  const jumps: string[] = [];
  const view = render(
    <AnalyticsContext value={analytics}>
      <IntlProvider locale="en" messages={english} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <WebReaderPresentationProvider>
            <AiHeadnotes
              analysis={analysis}
              blocks={blocks}
              language="cs"
              onAnchorClick={(startAnchorId, endAnchorId) => {
                jumps.push(`${startAnchorId}..${endAnchorId}`);
              }}
            />
          </WebReaderPresentationProvider>
        </FormattingProvider>
      </IntlProvider>
    </AnalyticsContext>,
  );
  return { jumps, view };
};

const openCard = async (view: ReturnType<typeof render>) =>
  await waitFor(
    () =>
      view.baseElement.querySelector<HTMLElement>(
        '[data-slot="preview-card-content"]',
      ) ?? panic("The paragraph card did not open"),
  );

const previewTexts = (card: HTMLElement) =>
  [...card.querySelectorAll("[data-paragraph-preview] > *")].map(
    (paragraph) => paragraph.textContent,
  );

test("focusing a range citation shows each cited paragraph in order, in the decision's language", async () => {
  const { view } = renderHeadnotes({
    analysis: analysisCiting([{ startAnchorId: "p-9", endAnchorId: "p-11" }]),
  });

  const chip = view.getByRole("button", { name: "Paragraph 9–11" });
  chip.focus();
  const card = await openCard(view);

  expect(previewTexts(card)).toEqual([`9${NINE}`, `10${TEN}`, `11${ELEVEN}`]);
  const preview =
    card.querySelector<HTMLElement>("[data-paragraph-preview]") ??
    panic("The card has no paragraph text");
  expect(preview.lang).toBe("cs");
  expect(preview.classList).toContain("reader-body");
  // Short paragraphs need no way out of the card; the chip itself jumps.
  expect(card.textContent).not.toContain("Go to paragraph");

  expect(Object.hasOwn(chip.dataset, "popupOpen")).toBe(true);
  fireEvent.keyDown(chip, { key: "Escape" });
  await waitFor(() => {
    expect(Object.hasOwn(chip.dataset, "popupOpen")).toBe(false);
  });
});

test("hovering a citation with the mouse shows its paragraph, and pressing it still jumps", async () => {
  const { jumps, view } = renderHeadnotes({
    analysis: analysisCiting([{ startAnchorId: "p-10", endAnchorId: "p-10" }]),
  });
  const chip = view.getByRole("button", { name: "Paragraph 10" });

  fireEvent.pointerEnter(chip, { pointerType: "mouse" });
  fireEvent.mouseEnter(chip);
  const card = await openCard(view);
  expect(previewTexts(card)).toEqual([`10${TEN}`]);

  fireEvent.click(chip);
  expect(jumps).toEqual(["p-10..p-10"]);
});

test("a citation the text does not contain draws no chip and no card, and is reported", async () => {
  const captured: unknown[] = [];
  const analytics: Analytics = {
    ...noopAnalytics,
    captureError: (error) => {
      captured.push(error);
    },
  };
  const { view } = renderHeadnotes({
    analysis: analysisCiting([
      { startAnchorId: "p-9", endAnchorId: "p-9" },
      { startAnchorId: "p-404", endAnchorId: "p-404" },
    ]),
    analytics,
  });

  expect(
    view
      .getAllByRole("button", { name: /^Paragraph /u })
      .map((button) => button.textContent),
  ).toEqual(["[9]"]);
  expect(
    view.baseElement.querySelector('[data-slot="preview-card-content"]'),
  ).toBeNull();
  await waitFor(() => {
    expect(captured).toHaveLength(1);
  });
});

test("a paragraph too long for the card is cut, with a way to the full text", async () => {
  const long = Array.from(
    { length: PARAGRAPH_PREVIEW_CHARACTER_LIMIT },
    (_, index) => `word${index}`,
  ).join(" ");
  const { jumps, view } = renderHeadnotes({
    analysis: analysisCiting([{ startAnchorId: "p-9", endAnchorId: "p-9" }]),
    blocks: [{ ...paragraphNine, plainText: long }],
  });

  const chip = view.getByRole("button", { name: "Paragraph 9" });
  chip.focus();
  const card = await openCard(view);
  const shown = previewTexts(card).at(0) ?? panic("The card shows no text");
  // The number, then a word-boundary prefix of the text, then the ellipsis.
  expect(shown.endsWith(" …")).toBe(true);
  expect(long.startsWith(shown.slice("9".length, -" …".length))).toBe(true);
  expect(shown.length).toBeLessThan(long.length);

  fireEvent.click(
    within(card).getByRole("button", { name: "Go to paragraph" }),
  );
  expect(jumps).toEqual(["p-9..p-9"]);
  await waitFor(() => {
    expect(Object.hasOwn(chip.dataset, "popupOpen")).toBe(false);
  });
});
