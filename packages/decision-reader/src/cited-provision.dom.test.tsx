import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Block } from "@stll/legal-ast/document-ast";
import { section72aSubsection1Blocks } from "@stll/legal-ast/fixtures/cz-141-1961-section-72a";

import { CitedProvisionExpansion, CitedProvisionPeek } from "./cited-provision";
import { fakeReaderAdapters } from "./decision-text.test";
import { BlockRenderer } from "./document-ast-text";
import { DecisionReaderProvider } from "./reader-adapters";
import type {
  CitedProvisionTarget,
  ProvisionPreviewData,
} from "./reader-types";

const citation = {
  document: {
    country: "cz",
    eli: "/eli/cz/sb/1961/141",
    id: "act",
    slug: null,
    versionValidFrom: "2026-01-01",
  },
  payload: {
    anchorId: "par_72a",
    documentId: "act",
    eli: "/eli/cz/sb/1961/141",
    highlightAnchorId: "par_72a-odst_1",
    jurisdiction: "CZE",
    provisionLabel: "§ 72a odst. 1",
    statuteTitle: "141/1961 Sb., o trestním řízení soudním (trestní řád)",
    versionCount: 1,
    versionValidFrom: "2026-01-01",
  },
  preview: null,
} satisfies CitedProvisionTarget;

const wording = {
  anchorId: "par_72a",
  blocks: section72aSubsection1Blocks,
  citedAnchorId: "par_72a-odst_1",
  documentId: "act",
  heading: null,
  headings: [],
  language: "cs",
} satisfies ProvisionPreviewData;

const wordings = [{ target: citation, wording }];

const LETTERS = ["a) ", "b) ", "c) ", "d) "];

const mount = async (children: ReactNode) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <DecisionReaderProvider adapters={fakeReaderAdapters}>
        {children}
      </DecisionReaderProvider>,
    );
  });
  return container;
};

const openCard = async (container: HTMLElement) => {
  const card =
    container.querySelector<HTMLElement>('[data-slot="provision-card"]') ??
    panic("Missing provision card");
  await act(async () => {
    card.click();
  });
  return card;
};

const wordingOf = (surface: Element) => {
  const all = surface.querySelectorAll('[data-slot="provision-card-wording"]');
  expect(all).toHaveLength(1);
  return all.item(0);
};

/** A provision drawn as one quotation, its letters hanging under the lead-in. */
const expectOneStructuredQuote = (surface: Element) => {
  const quoted = wordingOf(surface);
  expect(
    quoted.querySelectorAll('[data-slot="provision-card-quote"]'),
  ).toHaveLength(1);
  // The card frames the quotation; nothing inside draws a bar of its own.
  expect(quoted.querySelectorAll("[data-cited]")).toHaveLength(0);
  expect(quoted.querySelector('[class*="border-s"]')).toBeNull();
  // Quoted wording never claims the citing reader's anchors.
  expect(quoted.querySelector("[data-anchor], [id]")).toBeNull();

  const paragraphs = [...quoted.querySelectorAll("p")];
  expect(paragraphs.map((paragraph) => paragraph.textContent)).toEqual(
    section72aSubsection1Blocks.map(({ text }) => text),
  );
  const [leadIn, ...letters] = paragraphs;
  expect(leadIn?.classList.contains("reader-list-hang")).toBe(false);
  expect(leadIn?.querySelector(".reader-list-marker")).toBeNull();
  for (const letter of letters) {
    expect(letter.classList).toContain("reader-list-hang");
    expect(letter.classList).toContain("ms-4");
  }
  expect(
    letters.map(
      (letter) =>
        letter.firstElementChild?.matches(".reader-list-marker") &&
        letter.firstElementChild.textContent,
    ),
  ).toEqual(LETTERS);
  return paragraphs;
};

describe("a cited provision's wording", () => {
  // Scoped to this block: the shared fixture module brings its own tests,
  // which register the DOM themselves.
  let previousActEnvironment: unknown;

  beforeAll(() => {
    GlobalRegistrator.register();
    previousActEnvironment = Reflect.get(
      globalThis,
      "IS_REACT_ACT_ENVIRONMENT",
    );
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterAll(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
    await GlobalRegistrator.unregister();
  });
  test("the hover preview quotes a paragraph and its letters as one unit", async () => {
    const container = await mount(
      <CitedProvisionPeek provision={citation} wordings={wordings} />,
    );
    expectOneStructuredQuote(container);
  });

  test("an inline card quotes it as one unit once opened", async () => {
    const container = await mount(
      <CitedProvisionExpansion
        citations={[citation]}
        full={{ isPending: false, whole: null }}
        onToggleFull={() => undefined}
        showsFull={false}
        wordings={wordings}
      />,
    );
    expectOneStructuredQuote(await openCard(container));
  });

  test("a folded margin card glimpses the lead-in alone, an opened one the whole unit", async () => {
    const container = await mount(
      <CitedProvisionExpansion
        citations={[citation]}
        full={{ isPending: false, whole: null }}
        onToggleFull={() => undefined}
        placement="gutter"
        showsFull={false}
        wordings={wordings}
      />,
    );
    const glimpse =
      container.querySelector('[data-slot="provision-card-glimpse"]') ??
      panic("Missing folded margin glimpse");
    expect(
      [...wordingOf(glimpse).querySelectorAll("p")].map((p) => p.textContent),
    ).toEqual([section72aSubsection1Blocks[0].text]);

    const card = await openCard(container);
    expect(
      card.querySelector('[data-slot="provision-card-glimpse"]'),
    ).toBeNull();
    expectOneStructuredQuote(card);
  });

  test("beside the rest of the provision, the cited paragraph and its letters share one mark", async () => {
    const rest = {
      anchorId: "par_72a-odst_2",
      id: "par_72a-odst_2",
      text: "(2) Další odstavec.",
    };
    const container = await mount(
      <CitedProvisionExpansion
        citations={[citation]}
        full={{
          isPending: false,
          whole: {
            ...wording,
            blocks: [...section72aSubsection1Blocks, rest],
            citedAnchorId: null,
          },
        }}
        onToggleFull={() => undefined}
        showsFull
        wordings={wordings}
      />,
    );
    const quoted = wordingOf(await openCard(container));
    const quotes = [
      ...quoted.querySelectorAll<HTMLElement>(
        '[data-slot="provision-card-quote"]',
      ),
    ];
    expect(
      quotes.map((quote) => ({
        cited: Object.hasOwn(quote.dataset, "cited"),
        texts: [...quote.querySelectorAll("p")].map((p) => p.textContent),
      })),
    ).toEqual([
      {
        cited: true,
        texts: section72aSubsection1Blocks.map(({ text }) => text),
      },
      { cited: false, texts: [rest.text] },
    ]);
    expect(quoted.querySelectorAll('[class*="border-s"]')).toHaveLength(1);
  });

  test("the statute reader sets the same provision with the card's paragraph classes", async () => {
    // Stored as the statute's own blocks are: no list depth, only anchors.
    const stored = section72aSubsection1Blocks.map(
      ({ anchorId, id, text }): Block => ({
        anchorId,
        id,
        inlines: [{ text, type: "text" }],
        plainText: text,
        type: "paragraph",
      }),
    );
    const reader = await mount(
      <article>
        {stored.map((block) => (
          <BlockRenderer
            activeMatchIndex={-1}
            block={block}
            key={block.id}
            rangesByPieceId={{}}
            variant="statute"
          />
        ))}
      </article>,
    );
    const card = await mount(
      <CitedProvisionPeek provision={citation} wordings={wordings} />,
    );
    const classes = (root: Element) =>
      [...root.querySelectorAll("p")].map((paragraph) => paragraph.className);
    expect(classes(reader)).toEqual(classes(wordingOf(card)));
    expect(
      [...reader.querySelectorAll(".reader-list-marker")].map(
        (marker) => marker.textContent,
      ),
    ).toEqual(LETTERS);
  });
});
