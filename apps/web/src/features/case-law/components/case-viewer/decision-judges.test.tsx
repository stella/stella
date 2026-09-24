import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import {
  TEXT_ABSENCE_REASON,
  TEXT_FIELD_TYPE,
} from "@stll/api-contract/case-law-text-field";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import {
  DecisionJudges,
  judgePortraitSrc,
} from "@/features/case-law/components/case-viewer/decision-judges";
import { DecisionText } from "@/features/case-law/components/case-viewer/decision-text";
import type { DecisionJudge } from "@/features/case-law/decision-judges";
import { FormattingProvider } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/en.json";
import { toSafeId } from "@/lib/safe-id";

const RAPPORTEUR = {
  judgeId: toSafeId<"caseLawJudge">("00000000-0000-4000-8000-000000000001"),
  name: "Nováková Jana",
  portrait: {
    attribution: "Ústavní soud",
    url: "/v1/case/judges/00000000-0000-4000-8000-000000000001/portrait",
  },
  role: "rapporteur",
} as const satisfies DecisionJudge;

const DISSENTER = {
  judgeId: null,
  name: "Dvořák Petr",
  portrait: null,
  role: "dissenting",
} as const satisfies DecisionJudge;

const ABSENT = {
  reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
  type: TEXT_FIELD_TYPE.ABSENT,
} as const;

const ast = {
  blocks: [
    {
      anchorId: "p-1",
      id: "majority",
      inlines: [{ text: "Ústavní stížnost se zamítá.", type: "text" }],
      plainText: "Ústavní stížnost se zamítá.",
      type: "paragraph",
    },
    {
      anchorId: "p-2",
      id: "separate",
      inlines: [{ text: "S většinovým názorem nesouhlasím.", type: "text" }],
      plainText: "S většinovým názorem nesouhlasím.",
      role: "dissent",
      type: "paragraph",
    },
  ],
  metadata: {
    caseNumber: "Pl. ÚS 1/2026",
    court: "Ústavní soud",
    decisionDate: null,
    decisionType: "nález",
    ecli: null,
    keywords: [],
    statutes: [],
  },
  source: { documentId: "1", printUrl: "", system: "test", webUrl: "" },
  version: 1,
} satisfies DocumentAst;

const render = (node: ReactNode): string =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        {node}
      </FormattingProvider>
    </IntlProvider>,
  );

const renderDecision = (judges: readonly DecisionJudge[]): string =>
  render(
    <DecisionText
      activeMatchIndex={-1}
      decision={{
        caseNumber: "Pl. ÚS 1/2026",
        court: "Ústavní soud",
        courtAbbreviation: null,
        courtTier: "constitutional",
        documentAst: ast,
        documentPending: false,
        documentReadFailed: false,
        documentUnavailable: false,
        fulltext: null,
        id: toSafeId<"caseLawDecision">("9b1f0f3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"),
        judges: [...judges],
        language: "cs",
        sourceAttributionUrl: null,
        textFields: {
          abstract: ABSENT,
          headnote: ABSENT,
          legalSentence: ABSENT,
          summary: ABSENT,
        },
      }}
      decisionId="dec-1"
      searchQuery=""
    />,
  );

describe("the bench of a decision", () => {
  test("names each judge and stands their initials in for a face", () => {
    const markup = render(<DecisionJudges judges={[RAPPORTEUR, DISSENTER]} />);

    expect(markup).toContain(RAPPORTEUR.name);
    expect(markup).toContain(DISSENTER.name);
    // The avatar primitive resolves an image in the browser, so the server
    // pass draws initials for everyone; a judge the roster holds no portrait
    // for keeps them, and nothing about them is dimmed.
    expect(markup).toContain(">NJ<");
    expect(markup).toContain(">DP<");
    expect(markup).not.toContain("grayscale");
  });

  test("captions each judge with the part they played", () => {
    const markup = render(<DecisionJudges judges={[RAPPORTEUR, DISSENTER]} />);

    expect(markup).toContain(messages.caseLaw.viewer.judgeRole.rapporteur);
    expect(markup).toContain(messages.caseLaw.viewer.judgeRole.dissenting);
  });

  test("fetches a portrait from the API root, version prefix and all", () => {
    // The read's path already carries `/v1`, so the src is composed against
    // the API root; `apiUrl` would prepend the prefix a second time. The
    // avatar primitive resolves the image in the browser, so the composition
    // is asserted on its own rather than through the server pass's markup.
    expect(judgePortraitSrc(RAPPORTEUR.portrait.url)).toBe(
      `http://localhost:3001${RAPPORTEUR.portrait.url}`,
    );
    expect(judgePortraitSrc(RAPPORTEUR.portrait.url)).not.toContain("/v1/v1/");
  });

  test.each(["//example.test/portrait.jpg", "/\\example.test/portrait.jpg"])(
    "refuses %s, which addresses a host rather than this API",
    (path) => {
      // A network-path reference resolves against the scheme, not the API
      // root, so it is not a portrait address this app composes.
      expect(() => judgePortraitSrc(path)).toThrow(
        "Judge portrait path is not API-root-relative",
      );
    },
  );

  test("credits the source of the portraits it drew", () => {
    expect(render(<DecisionJudges judges={[RAPPORTEUR]} />)).toContain(
      `Portrait source: ${RAPPORTEUR.portrait.attribution}`,
    );
    // Initials are nobody's photograph, so there is nothing to credit.
    expect(render(<DecisionJudges judges={[DISSENTER]} />)).not.toContain(
      "Portrait source",
    );
  });
});

describe("the byline above a separate opinion", () => {
  test("names the dissenting judges where the text carries their opinion", () => {
    const markup = renderDecision([RAPPORTEUR, DISSENTER]);

    expect(markup).toContain("Dissenting:");
    // Isolated, so a Latin name inside an RTL reading does not scramble the
    // punctuation around it.
    expect(markup).toContain(`<bdi dir="auto">${DISSENTER.name}</bdi>`);
    // The byline labels the text rather than being part of it, so a quotation
    // taken from the paragraph below it does not carry it.
    expect(markup).toContain("data-reader-chrome");
    // The rapporteur signed the decision, not the separate opinion.
    expect(markup).not.toContain(RAPPORTEUR.name);
  });

  test("stays away when the read named nobody who wrote separately", () => {
    expect(renderDecision([RAPPORTEUR])).not.toContain("Dissenting:");
    expect(renderDecision([])).not.toContain("Dissenting:");
  });
});
