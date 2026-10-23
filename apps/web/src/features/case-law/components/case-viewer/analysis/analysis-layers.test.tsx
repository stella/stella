import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import type { DecisionAnalysisV3 } from "@stll/legal-ast/analysis";

import messages from "@/i18n/langs/en.json";

import { AnalysisLayers } from "./analysis-layers";

const analysis = {
  version: 3,
  generatedAt: "2026-10-12T09:00:00.000Z",
  model: "test-model",
  inputFingerprint: "fingerprint",
  tree: [],
  holding: { text: "Pravidlo.", language: "cs", anchors: [] },
  abstract: { text: "Abstrakt.", language: "cs" },
  topics: [],
} satisfies DecisionAnalysisV3;

const markup = (stored: DecisionAnalysisV3, citedLater: boolean) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <AnalysisLayers analysis={stored} citedLater={citedLater} />
    </IntlProvider>,
  );

test("a decision no later court cites draws no later-treatment section", () => {
  expect(
    markup(
      {
        ...analysis,
        significance: {
          kind: "none",
          graphFingerprint: "uncited",
          generatedAt: "2026-10-12T09:00:00.000Z",
        },
      },
      true,
    ),
  ).toBe("");
});

test("a note stored over an empty graph is not drawn while nothing cites the decision", () => {
  expect(
    markup(
      {
        ...analysis,
        significance: {
          text: "Toto rozhodnutí nebylo dosud citováno.",
          language: "cs",
          graphFingerprint: "uncited",
          generatedAt: "2026-10-12T09:00:00.000Z",
          model: "test-model",
          promptVersion: 1,
        },
      },
      false,
    ),
  ).toBe("");
});
