import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { ProvisionsCited } from "@/features/case-law/components/case-viewer/provisions-cited";
import { decisionProvisionKeys } from "@/features/case-law/queries/provisions";
import messages from "@/i18n/langs/en.json";
import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";

const decisionId: SafeId<"caseLawDecision"> = toSafeId<"caseLawDecision">(
  "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
);

const provision = (overrides: Record<string, unknown>) => ({
  anchor: "s265b",
  confidence: 0.9,
  jurisdiction: "CZE",
  letter: null,
  openEnded: false,
  point: null,
  section: 265,
  sectionSuffix: "b",
  sentence: null,
  spanEnd: 60,
  spanStart: 40,
  subsection: "1",
  unit: "section",
  workCollection: "Sb.",
  workEli: "/eli/cz/sb/1961/141",
  workIdentifier: "141/1961",
  ...overrides,
});

const renderPanel = (children: ReactNode, queryClient: QueryClient) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </IntlProvider>,
  );

const seed = (items: ReturnType<typeof provision>[]) => {
  const queryClient = new QueryClient();

  queryClient.setQueryData(decisionProvisionKeys.forDecision(decisionId), {
    pageParams: [null],
    pages: [{ items, limit: 50, nextCursor: null }],
  });

  return queryClient;
};

describe("ProvisionsCited", () => {
  test("says nothing about a decision that applies no provisions", () => {
    expect(
      renderPanel(<ProvisionsCited decisionId={decisionId} />, seed([])),
    ).toBe("");
  });

  test("names the panel, and states the references only once opened", () => {
    const markup = renderPanel(
      <ProvisionsCited decisionId={decisionId} isHydrated />,
      seed([provision({})]),
    );

    expect(markup).toContain(messages.caseLaw.viewer.provisionsCited);
    // Closed is the resting state: the references are a reading aid beside
    // the decision, and opening them is what resolves each cited work.
    expect(markup).not.toContain("§ 265b");
    expect(markup).toContain('aria-expanded="false"');
  });
});
