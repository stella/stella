import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import type { DecisionAnalysisV3 } from "@stll/legal-ast/analysis";

import messages from "@/i18n/langs/en.json";

import { AnalysisLayers } from "./analysis-layers";

test("a decision no later court cites draws no later-treatment section", () => {
  const analysis = {
    version: 3,
    generatedAt: "2026-10-12T09:00:00.000Z",
    model: "test-model",
    inputFingerprint: "fingerprint",
    tree: [],
    holding: { text: "Pravidlo.", language: "cs", anchors: [] },
    abstract: { text: "Abstrakt.", language: "cs" },
    topics: [],
    significance: {
      kind: "none",
      graphFingerprint: "uncited",
      generatedAt: "2026-10-12T09:00:00.000Z",
    },
  } satisfies DecisionAnalysisV3;

  expect(
    renderToStaticMarkup(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <AnalysisLayers analysis={analysis} />
      </IntlProvider>,
    ),
  ).toBe("");
});
