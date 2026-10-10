import type { ComponentProps, ReactNode } from "react";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { panic, Result } from "better-result";
import { expect, test } from "bun:test";

import {
  TEXT_FIELD_TYPE,
  TEXT_ABSENCE_REASON,
} from "@stll/api-contract/case-law-text-field";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { CitedProvisionExpansion } from "./cited-provision";
import type { FullProvisionRead } from "./cited-provision";
import { DecisionText, prepareDecisionTextPlacements } from "./decision-text";
import { BlockRenderer } from "./document-ast-text";
import {
  DecisionReaderProvider,
  ReaderPresentationProvider,
} from "./reader-adapters";
import type { DecisionReaderAdapters } from "./reader-adapters";
import type {
  CitedProvisionTarget,
  ProvisionPreviewData,
  ReaderDecision,
} from "./reader-types";

export const fakeReaderAdapters = {
  messages: {
    "statutes.diffRemoved": "Removed",
    "statutes.diffInserted": "Inserted",
    "common.copyLink": "Copy link",
    "common.back": "Back",
    "caseLaw.viewer.legalSentence": "Legal sentence",
    "caseLaw.viewer.abstract": "Abstract",
    "folio.comment": "Comment",
    "legalReader.annotations.highlight": "Highlight",
    "caseLaw.reader.headMatter": "Head matter",
    "caseLaw.notesFilter.ai": "AI",
    "common.court": "Court",
    "statutes.wordingVersionUnknown": "Wording version unknown",
    "statutes.openProvision": "Open provision",
    "statutes.provisionTextUnavailable": "Text not available",
    "statutes.showCitedPartOnly": "Show cited part only",
    "statutes.showFullProvision": "Show full provision",
    sourceAttribution: (source, link) => <>Source: {link(source)}</>,
    dissentByline: (names) => names.join(", "),
    provisionPartTextUnavailable: (provisionLabel) =>
      `Text of ${provisionLabel} is not available`,
    provisionEffectiveFrom: (date) => `in force since ${date}`,
    formatValidityDate: (date) => date,
    provisionActText: ({ statuteTitle }) => statuteTitle,
    formatLabelList: (labels) => labels.join(", "),
  },
  renderDecisionLink: ({ children, decision, className }) => (
    <a className={className} href={`#decision-${decision.id}`}>
      {children}
    </a>
  ),
  renderStatuteLink: (props) => {
    switch (props.type) {
      case "statute":
        return (
          <a href={`#statute-${props.target.document.id}`}>{props.children}</a>
        );
      case "provision":
        return (
          <a href={`#${props.provision.payload.anchorId}`}>{props.children}</a>
        );
      case "provision-expansion":
        return (
          <div data-slot="fake-provision-card">
            {props.citations.map(({ payload }) => payload.provisionLabel)}
          </div>
        );
      default:
        props satisfies never;
        throw new TypeError("Unknown fixture link");
    }
  },
  renderBodyUnavailable: ({ reason }) => <p>{reason}</p>,
  copyPermalink: () => undefined,
  openProvision: () => undefined,
  loadProvisionPreview: async () => ({
    documentId: "act",
    anchorId: "par_90",
    citedAnchorId: null,
    heading: null,
    language: "cs",
    headings: [],
    blocks: [],
  }),
} satisfies DecisionReaderAdapters;

export const renderReaderFixture = (children: ReactNode): string =>
  renderToStaticMarkup(
    <DecisionReaderProvider adapters={fakeReaderAdapters}>
      {children}
    </DecisionReaderProvider>,
  );

const text = "Soud odkázal na rozhodnutí 1 As 1/2026 a § 90.";
const ast = {
  blocks: [
    {
      type: "heading",
      id: "heading",
      anchorId: "h-1",
      level: 1,
      inlines: [{ type: "text", text: "Odůvodnění" }],
      plainText: "Odůvodnění",
    },
    {
      type: "paragraph",
      id: "paragraph",
      anchorId: "p-7",
      number: 48,
      inlines: [{ type: "text", text }],
      plainText: text,
    },
  ],
  metadata: {
    caseNumber: "2 As 2/2026",
    court: "Nejvyšší správní soud",
    decisionDate: null,
    decisionType: null,
    ecli: null,
    keywords: [],
    statutes: [],
  },
  source: {
    system: "fixture",
    documentId: "decision",
    webUrl: "https://court.example/decision",
    printUrl: "",
  },
  version: 1,
} satisfies DocumentAst;
const absent = {
  type: TEXT_FIELD_TYPE.ABSENT,
  reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
} as const;
const decision = {
  caseNumber: "2 As 2/2026",
  caseNumberType: "case-number",
  country: "CZE",
  court: "Nejvyšší správní soud",
  courtAbbreviation: null,
  courtTier: "supreme",
  documentAst: ast,
  documentPending: false,
  documentReadFailed: false,
  documentUnavailable: false,
  fulltext: null,
  id: "fixture-decision",
  judges: [],
  language: "cs",
  sourceAttributionUrl: "https://court.example/decision",
  textFields: {
    abstract: absent,
    headnote: absent,
    legalSentence: absent,
    summary: absent,
  },
} satisfies ReaderDecision;

test("a decision renders numbered anchored text and resolved marks without reading data", () => {
  let reads = 0;
  const renderedCitations: string[] = [];
  const adapters = {
    ...fakeReaderAdapters,
    renderDecisionLink: ({ citation, ...props }) => {
      renderedCitations.push(citation.id);
      expect(citation.decision).toBe(props.decision);
      expect(citation.treatment).toBe(props.treatment);
      return fakeReaderAdapters.renderDecisionLink({ citation, ...props });
    },
    loadProvisionPreview: async () => {
      reads += 1;
      return {
        documentId: "act",
        anchorId: "par_90",
        citedAnchorId: null,
        heading: null,
        language: "cs",
        headings: [],
        blocks: [],
      };
    },
  } satisfies DecisionReaderAdapters;
  const placements = prepareDecisionTextPlacements({
    adapters,
    blocks: ast.blocks,
    annotationAnchors: [],
    statuteCitationAnchors: [],
    citationAnchors: [
      {
        id: "citation",
        citationText: "1 As 1/2026",
        treatment: "positive",
        decision: {
          id: "cited",
          caseNumberType: "case-number",
          ecli: null,
          caseNumber: "1 As 1/2026",
          court: "Nejvyšší správní soud",
          country: "CZE",
          language: "cs",
          slug: null,
          languageAlternates: [],
          decisionDate: null,
        },
      },
    ],
    provisionAnchors: [
      {
        id: "provision",
        sentenceText: text,
        spanStart: 0,
        reference: {
          section: 90,
          sectionSuffix: null,
          subsection: null,
          letter: null,
          unit: "section",
        },
        target: {
          document: {
            country: "CZE",
            id: "act",
            eli: "eli/act",
            slug: null,
            versionValidFrom: null,
          },
          preview: null,
          payload: {
            documentId: "act",
            eli: "eli/act",
            jurisdiction: "CZE",
            anchorId: "par_90",
            provisionLabel: "§ 90",
            statuteTitle: "Zákon",
            versionValidFrom: null,
            versionCount: 1,
          },
        },
      },
    ],
  });
  const markup = renderToStaticMarkup(
    <DecisionReaderProvider adapters={adapters}>
      <DecisionText
        decision={decision}
        decisionId={decision.id}
        isHydrated
        placements={placements}
      />
    </DecisionReaderProvider>,
  );
  expect(markup).toContain('id="p-7"');
  expect(markup).toContain('data-anchor="p-7"');
  expect(markup).toContain("48");
  expect(markup).toContain("Odůvodnění");
  expect(markup).toContain('href="#decision-cited"');
  expect(markup).toContain('href="#par_90"');
  expect(markup).toContain('href="https://court.example/decision"');
  expect(placements.failures).toEqual([]);
  expect(reads).toBe(0);
  expect(renderedCitations).toEqual(["citation"]);
});

const permalinkFixture = (variant: "case-law" | "statute") =>
  ast.blocks.map((block) => (
    <BlockRenderer
      activeMatchIndex={-1}
      block={block}
      key={block.id}
      rangesByPieceId={{}}
      variant={variant}
    />
  ));

test("readers without a copy adapter expose no permalink control", () => {
  for (const variant of ["case-law", "statute"] as const) {
    const markup = renderToStaticMarkup(
      <ReaderPresentationProvider
        adapters={{ messages: fakeReaderAdapters.messages }}
      >
        {permalinkFixture(variant)}
      </ReaderPresentationProvider>,
    );
    expect(markup).toContain('data-anchor="h-1"');
    expect(markup).toContain('data-anchor="p-7"');
    expect(markup).toContain("Odůvodnění");
    expect(markup).not.toContain('aria-label="Copy link"');
    expect(markup).not.toContain('href="#h-1"');
    expect(markup).not.toContain('href="#p-7"');
    expect(markup).not.toContain("¶");
  }
});

test("a supplied copy adapter preserves existing permalink markup", () => {
  // Serialized copy controls before the optional adapter: placement and browser href stay exact.
  const anchorClass =
    "text-foreground-disabled hover:text-foreground focus-visible:ring-ring rounded-sm px-1 leading-[inherit] no-underline focus-visible:ring-2 focus-visible:outline-none print:hidden opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100";
  const previousControls = [
    `<a aria-label="Copy link" class="${anchorClass} ms-1" data-reader-chrome="" href="#h-1">¶</a>`,
    `<a aria-label="Copy link" class="${anchorClass} absolute end-full top-0 me-1" data-reader-chrome="" href="#p-7">¶</a>`,
  ];
  for (const variant of ["case-law", "statute"] as const) {
    const markup = renderReaderFixture(permalinkFixture(variant));
    expect(
      Array.from(markup.match(/<a aria-label="Copy link"[^>]*>¶<\/a>/gu) ?? []),
    ).toEqual(previousControls);
  }
});

test("a provision card identifies unavailable parts until its full wording recovers them", () => {
  const provision = (part: string) =>
    ({
      document: {
        country: "cz",
        eli: "/eli/cz/sb/2012/89",
        id: "act",
        slug: null,
        versionValidFrom: null,
      },
      payload: {
        anchorId: "par_5",
        documentId: "act",
        eli: "/eli/cz/sb/2012/89",
        highlightAnchorId: `par_5-odst_${part}`,
        jurisdiction: "CZE",
        provisionLabel: `§ 5 odst. ${part}`,
        statuteTitle: "Občanský zákoník",
        versionCount: 1,
        versionValidFrom: null,
      },
      preview: null,
    }) satisfies CitedProvisionTarget;
  const available = provision("1");
  const missing = provision("2");
  const wording = {
    anchorId: "par_5",
    blocks: [
      {
        anchorId: "par_5-odst_1",
        id: "part-1",
        text: "Odborná péče se posuzuje podle povolání.",
      },
    ],
    citedAnchorId: "par_5-odst_1",
    documentId: "act",
    heading: null,
    headings: [],
    language: "cs",
  };
  type RenderProvisionOptions = {
    availableWording: typeof wording | null;
    missingWording: typeof wording | null;
    full?: ComponentProps<typeof CitedProvisionExpansion>["full"];
    showsFull?: boolean;
  };
  const render = ({
    availableWording,
    missingWording,
    full = { isPending: false, whole: null },
    showsFull = false,
  }: RenderProvisionOptions) =>
    renderReaderFixture(
      <CitedProvisionExpansion
        citations={[available, missing]}
        full={full}
        onToggleFull={() => undefined}
        showsFull={showsFull}
        wordings={[
          { target: available, wording: availableWording },
          { target: missing, wording: missingWording },
        ]}
      />,
    );
  for (const missingWording of [null, { ...wording, blocks: [] }]) {
    const markup = render({ availableWording: wording, missingWording });
    expect(markup).toContain("Odborná péče se posuzuje podle povolání.");
    expect(markup).toMatch(
      /data-slot="provision-card-unavailable-part"[^>]*><bdi[^>]*>Text of § 5 odst\. 2 is not available<\/bdi>/u,
    );
    expect(markup.indexOf("Odborná péče")).toBeLessThan(
      markup.indexOf("Text of § 5 odst. 2"),
    );
    expect(markup).not.toContain('data-slot="provision-card-unavailable"');
  }
  for (const whole of [null, { ...wording, blocks: [] }]) {
    const markup = render({
      availableWording: wording,
      missingWording: null,
      showsFull: true,
      full: { isPending: false, whole },
    });
    expect(markup).toContain("Odborná péče se posuzuje podle povolání.");
    expect(markup).toContain("Text of § 5 odst. 2 is not available");
    expect(markup).toMatch(
      /data-slot="provision-card-full-unavailable"[^>]*>Text not available<\/span>/u,
    );
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Show full provision");
    expect(markup).not.toContain("Show cited part only");
  }
  const fullAvailableBlock = {
    anchorId: "par_5-odst_1",
    id: "full-part-1",
    text: "Odborná péče se posuzuje podle povolání.",
  };
  const fullMissingBlock = {
    anchorId: "par_5-odst_2",
    id: "full-part-2",
    text: "Doplněné znění druhého odstavce.",
  };
  const fullMissingChildBlock = {
    anchorId: "par_5-odst_2-pism_a",
    id: "full-part-2-letter-a",
    text: "Písmeno citovaného druhého odstavce.",
  };
  const uncitedFullBlock = {
    anchorId: "par_5-odst_3",
    id: "full-part-3",
    text: "Necitované znění třetího odstavce.",
  };
  for (const missingWording of [null, { ...wording, blocks: [] }]) {
    const unresolved = render({
      availableWording: wording,
      missingWording,
      showsFull: true,
      full: {
        isPending: false,
        whole: {
          ...wording,
          citedAnchorId: null,
          blocks: [fullAvailableBlock, uncitedFullBlock],
        },
      },
    });
    expect(unresolved).toContain('aria-expanded="true"');
    expect(unresolved).toContain("Show cited part only");
    expect(unresolved).not.toContain(
      'data-slot="provision-card-full-unavailable"',
    );
    expect(unresolved).toContain("Odborná péče se posuzuje podle povolání.");
    expect(unresolved).toContain("Text of § 5 odst. 2 is not available");
    expect(unresolved).toContain('data-slot="provision-card-unavailable-part"');
    expect(unresolved).toMatch(
      /<span[^>]*data-cited=""[^>]*>Odborná péče se posuzuje podle povolání\.<\/span>/u,
    );
    expect(unresolved).toMatch(
      /<span(?![^>]*data-cited=)[^>]*>Necitované znění třetího odstavce\.<\/span>/u,
    );
    const recovered = render({
      availableWording: wording,
      missingWording,
      showsFull: true,
      full: {
        isPending: false,
        whole: {
          ...wording,
          citedAnchorId: null,
          blocks: [
            fullAvailableBlock,
            fullMissingBlock,
            fullMissingChildBlock,
            uncitedFullBlock,
          ],
        },
      },
    });
    expect(recovered).not.toContain(
      'data-slot="provision-card-unavailable-part"',
    );
    expect(recovered).not.toContain("Text of § 5 odst. 2 is not available");
    expect(recovered).toMatch(
      /<span[^>]*data-cited=""[^>]*>Odborná péče se posuzuje podle povolání\.<\/span>/u,
    );
    expect(recovered).toMatch(
      /<span[^>]*data-cited=""[^>]*>Doplněné znění druhého odstavce\.<\/span>/u,
    );
    expect(recovered).toMatch(
      /<span[^>]*data-cited=""[^>]*>Písmeno citovaného druhého odstavce\.<\/span>/u,
    );
    expect(recovered).toMatch(
      /<span(?![^>]*data-cited=)[^>]*>Necitované znění třetího odstavce\.<\/span>/u,
    );
  }
  const allUnavailable = render({
    availableWording: null,
    missingWording: { ...wording, blocks: [] },
  });
  expect(allUnavailable).toContain('data-slot="provision-card-unavailable"');
  expect(allUnavailable).not.toContain(
    'data-slot="provision-card-unavailable-part"',
  );
});

for (const response of ["error", "null", "empty"] as const) {
  test(`an unavailable full provision (${response}) can fold back and retry`, async () => {
    const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
    GlobalRegistrator.register();
    const previousActEnvironment = Reflect.get(
      globalThis,
      "IS_REACT_ACT_ENVIRONMENT",
    );
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const citation = {
      document: {
        country: "cz",
        eli: "/eli/cz/sb/2012/89",
        id: "act",
        slug: null,
        versionValidFrom: null,
      },
      payload: {
        anchorId: "par_5",
        documentId: "act",
        eli: "/eli/cz/sb/2012/89",
        highlightAnchorId: "par_5-odst_1",
        jurisdiction: "CZE",
        provisionLabel: "§ 5 odst. 1",
        statuteTitle: "Občanský zákoník",
        versionCount: 1,
        versionValidFrom: null,
      },
      preview: null,
    } satisfies CitedProvisionTarget;
    const wording = {
      anchorId: "par_5",
      blocks: [
        { anchorId: "par_5-odst_1", id: "part-1", text: "Cited wording." },
      ],
      citedAnchorId: "par_5-odst_1",
      documentId: "act",
      heading: null,
      headings: [],
      language: "cs",
    } satisfies ProvisionPreviewData;
    const requests: ReturnType<
      typeof Promise.withResolvers<ProvisionPreviewData | null>
    >[] = [];
    const readFull = () => {
      const request = Promise.withResolvers<ProvisionPreviewData | null>();
      requests.push(request);
      return request.promise;
    };
    const Card = () => {
      const [shown, setShown] = useState<"cited" | "full">("cited");
      const [full, setFull] = useState<FullProvisionRead>({
        isPending: false,
        whole: null,
      });
      const onToggleFull = async () => {
        if (shown === "full") {
          setShown("cited");
          return;
        }
        setShown("full");
        setFull({ isPending: true, whole: null });
        const result = await Result.tryPromise(readFull);
        setFull({
          isPending: false,
          whole: result.isOk() ? result.value : null,
        });
      };
      return (
        <DecisionReaderProvider adapters={fakeReaderAdapters}>
          <CitedProvisionExpansion
            citations={[citation]}
            full={full}
            onToggleFull={onToggleFull}
            showsFull={shown === "full"}
            wordings={[{ target: citation, wording }]}
          />
        </DecisionReaderProvider>
      );
    };
    try {
      await act(async () => {
        root.render(<Card />);
      });
      const toggle =
        container.querySelector<HTMLButtonElement>("button[aria-expanded]") ??
        panic("Missing provision toggle");
      await act(async () => {
        toggle.click();
      });
      expect(requests).toHaveLength(1);
      expect(toggle.disabled).toBe(true);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(container.textContent).toContain("Cited wording.");
      await act(async () => {
        const request = requests.at(0) ?? panic("Missing full provision read");
        switch (response) {
          case "error":
            request.reject(new DOMException("Read failed", "NetworkError"));
            break;
          case "null":
            request.resolve(null);
            break;
          case "empty":
            request.resolve({ ...wording, blocks: [] });
            break;
          default:
            response satisfies never;
        }
      });
      expect(toggle.disabled).toBe(false);
      expect(toggle.textContent).toBe("Show full provision");
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(
        container.querySelector('[data-slot="provision-card-full-unavailable"]')
          ?.textContent,
      ).toBe("Text not available");
      await act(async () => {
        toggle.click();
      });
      expect(
        container.querySelector(
          '[data-slot="provision-card-full-unavailable"]',
        ),
      ).toBeNull();
      expect(container.textContent).toContain("Cited wording.");
      expect(toggle.disabled).toBe(false);
      expect(requests).toHaveLength(1);
      await act(async () => {
        toggle.click();
      });
      expect(requests).toHaveLength(2);
      expect(toggle.disabled).toBe(true);
      await act(async () => {
        const retry = requests.at(1) ?? panic("Missing retry read");
        retry.resolve({
          ...wording,
          blocks: [
            ...wording.blocks,
            {
              anchorId: "par_5-odst_2",
              id: "part-2",
              text: "Rest of provision.",
            },
          ],
        });
      });
      expect(toggle.disabled).toBe(false);
      expect(toggle.textContent).toBe("Show cited part only");
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(container.textContent).toContain("Rest of provision.");
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      if (previousActEnvironment === undefined) {
        Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
      } else {
        Reflect.set(
          globalThis,
          "IS_REACT_ACT_ENVIRONMENT",
          previousActEnvironment,
        );
      }
      await GlobalRegistrator.unregister();
    }
  });
}
