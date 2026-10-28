import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { DecisionAnalysis } from "@stll/legal-ast/analysis";
import type { Block } from "@stll/legal-ast/document-ast";

import english from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test/law" });
const { cleanup, fireEvent, render, within } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { WebReaderPresentationProvider } =
  await import("@/components/legal-reader/web-reader-presentation");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AiHeadnotes } = await import("./ai-headnotes");

afterEach(cleanup);
afterAll(unregisterDomEnvironment);

const blocks = [
  {
    id: "unnumbered",
    anchorId: "p-1",
    type: "paragraph",
    inlines: [],
    plainText: "Introduction",
  },
  {
    id: "nine",
    anchorId: "p-2",
    type: "paragraph",
    number: 9,
    inlines: [],
    plainText: "Start",
  },
  {
    id: "twelve",
    anchorId: "p-3",
    type: "paragraph",
    number: 12,
    inlines: [],
    plainText: "End",
  },
  {
    id: "fifty-seven",
    anchorId: "p-4",
    type: "paragraph",
    number: 57,
    inlines: [],
    plainText: "Holding",
  },
] satisfies Block[];

const analysis = {
  version: 4,
  generatedAt: "2026-10-18T00:00:00Z",
  model: "fixture-model",
  inputFingerprint: "fixture-document",
  tree: [],
  holding: {
    spans: [
      {
        text: "The agreement is invalid",
        anchors: [
          { startAnchorId: "p-4", endAnchorId: "p-4" },
          { startAnchorId: "p-2", endAnchorId: "p-3" },
          { startAnchorId: "p-4", endAnchorId: "p-4" },
          { startAnchorId: "p-1", endAnchorId: "p-1" },
        ],
      },
      { text: ", so the claim fails.", anchors: [] },
    ],
    language: "en",
  },
  abstract: {
    spans: [
      {
        text: "The parties signed an agreement ",
        anchors: [{ startAnchorId: "p-2", endAnchorId: "p-2" }],
      },
      {
        text: "that the court held invalid.",
        anchors: [{ startAnchorId: "p-4", endAnchorId: "p-4" }],
      },
    ],
    language: "en",
  },
  topics: [],
} satisfies DecisionAnalysis;

/** The passage a citation button sits in, read as one string. */
const passageOf = (button: HTMLElement): string | null | undefined =>
  button.closest("p")?.textContent;

test("holding cites sorted source paragraphs inline with numbered and position labels", () => {
  const jumps: string[] = [];
  const view = render(
    <IntlProvider locale="en" messages={english} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <WebReaderPresentationProvider>
          <AiHeadnotes
            analysis={analysis}
            blocks={blocks}
            language="en"
            onAnchorClick={(startAnchorId, endAnchorId) => {
              jumps.push(startAnchorId);
              const start = blocks.findIndex(
                (block) => block.anchorId === startAnchorId,
              );
              const end = blocks.findIndex(
                (block) => block.anchorId === endAnchorId,
              );
              for (const block of blocks.slice(start, end + 1)) {
                const element = view.container.querySelector<HTMLElement>(
                  `[data-anchor="${block.anchorId}"]`,
                );
                if (element) {
                  element.dataset["highlight"] = "";
                }
              }
            }}
          />
        </WebReaderPresentationProvider>
      </FormattingProvider>
      {blocks.map((block) => (
        <p data-anchor={block.anchorId} key={block.anchorId} />
      ))}
    </IntlProvider>,
  );

  const holdingCitation = view.getByRole("button", { name: "Paragraph ¶1" });
  // The claim's citations sit where the claim ends, inside the sentence.
  expect(passageOf(holdingCitation)).toBe(
    "The agreement is invalid [¶1] [9]-[12] [57], so the claim fails.",
  );
  const holding = holdingCitation.closest("p");
  expect(view.queryByText("Go to paragraph")).toBeNull();
  expect(within(holding!).getAllByRole("button")).toHaveLength(3);
  expect(
    within(holding!).getByRole("button", { name: "Paragraph 57" }).textContent,
  ).toBe("[57]");
  expect(view.getByRole("button", { name: "Paragraph 9–12" }).textContent).toBe(
    "[9]-[12]",
  );
  expect(holdingCitation.textContent).toBe("[¶1]");

  fireEvent.click(view.getByRole("button", { name: "Paragraph 9–12" }));
  expect(jumps).toEqual(["p-2"]);
  expect(
    view.container.querySelector<HTMLElement>('[data-anchor="p-2"]')?.dataset[
      "highlight"
    ],
  ).toBe("");
  expect(
    view.container.querySelector<HTMLElement>('[data-anchor="p-3"]')?.dataset[
      "highlight"
    ],
  ).toBe("");
  expect(
    view.container.querySelector<HTMLElement>('[data-anchor="p-4"]')?.dataset[
      "highlight"
    ],
  ).toBeUndefined();
});

test("paragraph references use the configured numbering system", () => {
  const view = render(
    <IntlProvider locale="en" messages={english} timeZone="UTC">
      <FormattingProvider locale="ar-u-nu-arab" timeZone="UTC">
        <WebReaderPresentationProvider>
          <AiHeadnotes
            analysis={analysis}
            blocks={blocks}
            language="en"
            onAnchorClick={() => undefined}
          />
        </WebReaderPresentationProvider>
      </FormattingProvider>
    </IntlProvider>,
  );

  expect(
    view.getAllByRole("button", { name: "Paragraph ٥٧" }).at(0)?.textContent,
  ).toBe("[٥٧]");
  expect(view.getByRole("button", { name: "Paragraph ٩–١٢" }).textContent).toBe(
    "[٩]-[١٢]",
  );
  expect(view.getByRole("button", { name: "Paragraph ¶١" }).textContent).toBe(
    "[¶١]",
  );
});

test("the abstract cites each claim, after its last word and before the space", () => {
  const view = render(
    <IntlProvider locale="en" messages={english} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <WebReaderPresentationProvider>
          <AiHeadnotes
            analysis={analysis}
            blocks={blocks}
            language="en"
            onAnchorClick={() => undefined}
          />
        </WebReaderPresentationProvider>
      </FormattingProvider>
    </IntlProvider>,
  );

  expect(passageOf(view.getByRole("button", { name: "Paragraph 9" }))).toBe(
    "The parties signed an agreement [9] that the court held invalid. [57]",
  );
});

test("a range listed twice around another range from the same start shows once", () => {
  const interleaved = {
    ...analysis,
    holding: {
      ...analysis.holding,
      spans: [
        {
          text: "The agreement is invalid.",
          anchors: [
            { startAnchorId: "p-2", endAnchorId: "p-3" },
            { startAnchorId: "p-2", endAnchorId: "p-4" },
            { startAnchorId: "p-2", endAnchorId: "p-3" },
          ],
        },
      ],
    },
  } satisfies DecisionAnalysis;
  const view = render(
    <IntlProvider locale="en" messages={english} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <WebReaderPresentationProvider>
          <AiHeadnotes
            analysis={interleaved}
            blocks={blocks}
            language="en"
            onAnchorClick={() => undefined}
          />
        </WebReaderPresentationProvider>
      </FormattingProvider>
    </IntlProvider>,
  );

  expect(passageOf(view.getByRole("button", { name: "Paragraph 9–57" }))).toBe(
    "The agreement is invalid. [9]-[12] [9]-[57]",
  );
});
