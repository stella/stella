import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";

import {
  TEXT_FIELD_TYPE,
  TEXT_ABSENCE_REASON,
} from "@stll/api-contract/case-law-text-field";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { DecisionText, prepareDecisionTextPlacements } from "./decision-text";
import { DecisionReaderProvider } from "./reader-adapters";
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
    "statutes.wordingVersionUnknown": "Wording version unknown",
    "statutes.openProvision": "Open provision",
    "statutes.provisionTextUnavailable": "Text not available",
    "statutes.showCitedPartOnly": "Show cited part only",
    "statutes.showFullProvision": "Show full provision",
    sourceAttribution: (source, link) => <>Source: {link(source)}</>,
    dissentByline: (names) => names.join(", "),
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
  const adapters = {
    ...fakeReaderAdapters,
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
});
