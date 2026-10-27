import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { PublicCountry } from "@stll/api-contract/public-country-capability";
import type { Block } from "@stll/legal-ast/document-ast";
import { section72aSubsection1Blocks } from "@stll/legal-ast/fixtures/cz-141-1961-section-72a";
import { section128Subsection2Blocks } from "@stll/legal-ast/fixtures/sk-300-2005-section-128";
import {
  E_SBIRKA_LIST_SCHEME,
  SLOV_LEX_LIST_SCHEME,
} from "@stll/legal-ast/statute-list";

import { CitedProvisionExpansion, CitedProvisionPeek } from "./cited-provision";
import { fakeReaderAdapters } from "./decision-text.test";
import { BlockRenderer } from "./document-ast-text";
import { DecisionReaderProvider } from "./reader-adapters";
import type {
  CitedProvisionTarget,
  ProvisionPreviewData,
} from "./reader-types";

const CZECH_JURISDICTION = "CZE" satisfies PublicCountry;
const SLOVAK_JURISDICTION = "SVK" satisfies PublicCountry;

const citation = {
  document: {
    country: CZECH_JURISDICTION.toLowerCase(),
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
    jurisdiction: CZECH_JURISDICTION,
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

const slovakCitation = {
  document: {
    country: SLOVAK_JURISDICTION,
    eli: "/eli/sk/zz/2005/300",
    id: "sk-act",
    slug: null,
    versionValidFrom: "2026-08-18",
  },
  payload: {
    anchorId: "paragraf-128",
    documentId: "sk-act",
    eli: "/eli/sk/zz/2005/300",
    highlightAnchorId: "paragraf-128.odsek-2",
    jurisdiction: SLOVAK_JURISDICTION,
    provisionLabel: "§ 128 ods. 2",
    statuteTitle: "300/2005 Z. z., Trestný zákon",
    versionCount: 1,
    versionValidFrom: "2026-08-18",
  },
  preview: null,
} satisfies CitedProvisionTarget;

const slovakWording = {
  anchorId: "paragraf-128",
  blocks: section128Subsection2Blocks.map(({ anchorId, id, plainText }) => ({
    anchorId,
    id,
    text: plainText,
  })),
  citedAnchorId: "paragraf-128.odsek-2",
  documentId: "sk-act",
  heading: null,
  headings: [],
  language: "sk",
} satisfies ProvisionPreviewData;

const LETTERS = ["a) ", "b) ", "c) ", "d) "];

const paragraphClasses = (root: Element) =>
  [...root.querySelectorAll("p")].map((paragraph) => paragraph.className);

const listMarkers = (root: Element) =>
  [...root.querySelectorAll(".reader-list-marker")].map(
    (marker) => marker.textContent,
  );

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
            statuteLists={E_SBIRKA_LIST_SCHEME}
            variant="statute"
          />
        ))}
      </article>,
    );
    const card = await mount(
      <CitedProvisionPeek provision={citation} wordings={wordings} />,
    );
    expect(paragraphClasses(reader)).toEqual(paragraphClasses(wordingOf(card)));
    expect(listMarkers(reader)).toEqual(LETTERS);
  });

  test("a Slovak provision nests and hangs its letters in the reader and the card alike", async () => {
    const reader = await mount(
      <article>
        {section128Subsection2Blocks.map((block) => (
          <BlockRenderer
            activeMatchIndex={-1}
            anchorPresentation="embedded"
            block={block}
            key={block.id}
            rangesByPieceId={{}}
            statuteLists={SLOV_LEX_LIST_SCHEME}
            variant="statute"
          />
        ))}
      </article>,
    );
    const card = await mount(
      <CitedProvisionPeek
        provision={slovakCitation}
        wordings={[{ target: slovakCitation, wording: slovakWording }]}
      />,
    );
    const paragraphs = [...reader.querySelectorAll("p")];
    // The designator stored as its own run hangs, and the text reads as stored.
    expect(paragraphs.map((paragraph) => paragraph.textContent)).toEqual(
      section128Subsection2Blocks.map(({ plainText }) => plainText),
    );
    expect(listMarkers(reader)).toEqual(LETTERS);
    expect(
      paragraphs.map((paragraph) => ({
        hangs: paragraph.classList.contains("reader-list-hang"),
        indented: paragraph.classList.contains("ms-4"),
      })),
    ).toEqual([
      { hangs: false, indented: false },
      { hangs: true, indented: true },
      { hangs: true, indented: true },
      { hangs: true, indented: true },
      { hangs: true, indented: true },
      // The tail closes the lead-in's sentence, under the lead-in.
      { hangs: false, indented: false },
    ]);
    expect(paragraphClasses(reader)).toEqual(paragraphClasses(wordingOf(card)));
    expect(listMarkers(wordingOf(card))).toEqual(LETTERS);
  });
});
