import type { ComponentProps } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { DECISION_DATE_VERSION_BASIS } from "@stll/api-contract/provision-version-basis";

import { toSafeId } from "@/lib/safe-id";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
const { cleanup, render, fireEvent, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { ProvisionsCited } =
  await import("@/features/case-law/components/case-viewer/provisions-cited");
const { CitingDecisionItem } =
  await import("@/features/statutes/components/provision-citing-decisions");
const { decisionProvisionsInfiniteOptions } =
  await import("@/features/case-law/queries/provisions");
const en = (await import("@/i18n/langs/en.json")).default;
const ar = (await import("@/i18n/langs/ar.json")).default;
const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const decisionId = toSafeId<"caseLawDecision">(
  "00000000-0000-4000-8000-000000000001",
);
const decision = {
  decisionId,
  caseNumber: "1 C 1/2020",
  country: "CZE",
  court: "Supreme Court",
  language: "cs",
  languageAlternates: [],
  slug: "decision",
  decisionDate: "2020-01-01",
  citationAuthority: 1,
  sentenceText: "§ 13",
  spanStart: 0,
  spanEnd: 4,
  versionBasis: DECISION_DATE_VERSION_BASIS,
} satisfies ComponentProps<typeof CitingDecisionItem>["decision"];

for (const [locale, messages] of [
  ["en", en],
  ["ar", ar],
] as const) {
  test(`${locale}: both provision citation views disclose decision-date inference`, async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    clients.push(client);
    const options = decisionProvisionsInfiniteOptions(decisionId);
    type Page = Awaited<ReturnType<NonNullable<typeof options.queryFn>>>;
    const item = {
      anchor: "s13",
      confidence: 1,
      jurisdiction: "CZE",
      letter: null,
      openEnded: false,
      point: null,
      section: 13,
      sectionSuffix: null,
      sentence: null,
      sentenceText: "§ 13",
      spanEnd: 4,
      spanStart: 0,
      subsection: null,
      unit: "section",
      workCollection: "Sb.",
      workEli: null,
      workIdentifier: "82/1998",
      workNumber: 82,
      workYear: 1998,
      workSource: "number",
      versionValidFrom: "2020-01-01",
      versionBasis: DECISION_DATE_VERSION_BASIS,
      previewKey: null,
      spanRole: null,
      printPieceId: null,
      printStart: null,
      printEnd: null,
      printText: null,
      namePieceId: null,
      nameStart: null,
      nameEnd: null,
      nameText: null,
      selection: null,
      printedWorkIdentifier: null,
      targetDocumentId: null,
      targetStatus: null,
    } as const satisfies Page["items"][number];
    client.setQueryData(options.queryKey, {
      pageParams: [null],
      pages: [
        {
          items: [item],
          limit: 50,
          nextCursor: null,
          previews: [],
          status: { type: "legacy" },
          generation: "0",
          publishedProjectionDigest: null,
        } satisfies Page,
      ],
    });
    const root = router.createRootRoute({
      component: () => (
        <>
          <ProvisionsCited
            decisionDate="2020-01-01"
            decisionId={decisionId}
            isHydrated
          />
          <CitingDecisionItem decision={decision} />
        </>
      ),
    });
    const appRouter = router.createRouter({
      routeTree: root,
      history: router.createMemoryHistory({ initialEntries: ["/"] }),
      isServer: false,
    });
    await appRouter.load();
    const ui = render(
      <QueryClientProvider client={client}>
        <IntlProvider
          locale={locale}
          messages={messages}
          timeZone="Europe/Prague"
        >
          <FormattingProvider locale={locale} timeZone="Europe/Prague">
            <router.RouterProvider router={appRouter} />
          </FormattingProvider>
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(
      ui.getByRole("link", { name: /1 C 1\/2020/u }).textContent,
    ).toContain(messages.caseLaw.viewer.versionAtDecisionDateInferred);
    fireEvent.click(
      ui.getByRole("button", { name: messages.caseLaw.viewer.provisionsCited }),
    );
    expect(
      ui.getAllByText(messages.caseLaw.viewer.versionAtDecisionDateInferred),
    ).toHaveLength(2);
    expect(
      within(
        ui
          .getByRole("button", {
            name: messages.caseLaw.viewer.provisionsCited,
          })
          .closest("section") ?? ui.container,
      )
        .getByText("§ 13")
        .closest("li")?.textContent,
    ).toContain(messages.caseLaw.viewer.versionAtDecisionDateInferred);
  });
}
