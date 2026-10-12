import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";

import {
  TEXT_FIELD_TYPE,
  TEXT_ABSENCE_REASON,
} from "@stll/api-contract/case-law-text-field";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { DecisionText, prepareDecisionTextPlacements } from "./decision-text";
import { BlockRenderer } from "./document-ast-text";
import {
  DecisionReaderProvider,
  ReaderPresentationProvider,
} from "./reader-adapters";
import type { DecisionReaderAdapters } from "./reader-adapters";
import type { ReaderDecision } from "./reader-types";

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
    "statutes.currentWording": "Current wording",
    "statutes.wordingVersionUnknown": "Wording version unknown",
    "statutes.openProvision": "Open provision",
    sourceAttribution: (source, link) => <>Source: {link(source)}</>,
    dissentByline: (names) => names.join(", "),
    wordingValidFrom: (date) => `Wording valid from ${date}`,
    formatValidityDate: (date) => date,
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
        return <div data-slot="fake-provision-card">{props.label}</div>;
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
