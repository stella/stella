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
  version: 3,
  generatedAt: "2026-10-18T00:00:00Z",
  model: "fixture-model",
  inputFingerprint: "fixture-document",
  tree: [],
  holding: {
    text: "The agreement is invalid.",
    language: "en",
    anchors: [
      { startAnchorId: "p-4", endAnchorId: "p-4" },
      { startAnchorId: "p-2", endAnchorId: "p-3" },
      { startAnchorId: "p-4", endAnchorId: "p-4" },
      { startAnchorId: "p-1", endAnchorId: "p-1" },
    ],
  },
  abstract: { text: "A summary.", language: "en" },
  topics: [],
} satisfies DecisionAnalysis;

test("holding cites sorted source paragraphs inline with numbered and position labels", () => {
  const jumps: string[] = [];
  const view = render(
    <IntlProvider locale="en" messages={english} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <WebReaderPresentationProvider>
          <AiHeadnotes
            analysis={analysis}
            blocks={blocks}
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

  const holding = view.getByText("The agreement is invalid.").parentElement;
  expect(holding?.textContent).toBe(
    "The agreement is invalid. [¶1] [9]-[12] [57]",
  );
  expect(view.queryByText("Go to paragraph")).toBeNull();
  expect(within(holding!).getAllByRole("button")).toHaveLength(3);
  expect(view.getByRole("button", { name: "Paragraph 57" }).textContent).toBe(
    "[57]",
  );
  expect(view.getByRole("button", { name: "Paragraph 9–12" }).textContent).toBe(
    "[9]-[12]",
  );
  expect(view.getByRole("button", { name: "Paragraph ¶1" }).textContent).toBe(
    "[¶1]",
  );

  fireEvent.click(view.getByRole("button", { name: "Paragraph 9–12" }));
  expect(jumps).toEqual(["p-2"]);
  expect(
    view.container.querySelector('[data-anchor="p-2"]')?.dataset["highlight"],
  ).toBe("");
  expect(
    view.container.querySelector('[data-anchor="p-3"]')?.dataset["highlight"],
  ).toBe("");
  expect(
    view.container.querySelector('[data-anchor="p-4"]')?.dataset["highlight"],
  ).toBeUndefined();
});
