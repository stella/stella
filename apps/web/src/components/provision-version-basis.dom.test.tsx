import type { ComponentProps } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { STATED_DATE_RELATIONS } from "@stll/api-contract/provision-applied-version";
import { DECISION_DATE_VERSION_BASIS } from "@stll/api-contract/provision-version-basis";
import type { ProvisionVersionBasis } from "@stll/api-contract/provision-version-basis";

import { toSafeId } from "@/lib/safe-id";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
const { cleanup, render, fireEvent, within, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { buildFormattingLocale } = await import("@/i18n/i18n-store");
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
  versionValidFrom: "2020-01-01",
  inferredVersionCandidate: {
    type: "inferred",
    kind: "decision_date",
    versionValidFrom: "2020-01-01",
  },
} satisfies ComponentProps<typeof CitingDecisionItem>["decision"];

for (const [locale, messages, year] of [
  ["en", en, "2014"],
  ["ar", ar, "٢٠١٤"],
] as const) {
  const formattingLocale = buildFormattingLocale({
    lang: locale,
    region: "",
    regionalFormat: "auto",
    calendar: "auto",
    numberingSystem: "auto",
    weekStart: "auto",
  });
  const cases = [
    {
      basis: DECISION_DATE_VERSION_BASIS,
      label: messages.caseLaw.viewer.versionAtDecisionDateInferred,
      compactLabel: messages.caseLaw.viewer.versionBasisInferredCompact,
    },
    {
      basis: { type: "not_stated" },
      label: messages.caseLaw.viewer.appliedVersionNotStated,
      compactLabel: messages.caseLaw.viewer.appliedVersionNotStatedCompact,
    },
    {
      basis: {
        type: "stated_version",
        amendmentWorkIdentifier: "303/2013 Sb.",
        expression: null,
        evidence: { kind: "stated_version", start: 0, end: 10 },
      },
      label: "303/2013 Sb.",
      compactLabel: "303/2013 Sb.",
    },
    ...STATED_DATE_RELATIONS.map(
      (relation) =>
        ({
          basis: {
            type: "stated_date",
            date: "2014-01-01",
            relation,
            expression: null,
            evidence: { kind: "stated_date", start: 0, end: 10 },
          },
          label: year,
          compactLabel: year,
        }) as const,
    ),
  ] as const satisfies readonly {
    basis: ProvisionVersionBasis;
    label: string;
    compactLabel: string;
  }[];
  for (const { basis, label, compactLabel } of cases) {
    test(`${locale}: both provision citation views disclose ${basis.type}${basis.type === "stated_date" ? `:${basis.relation}` : ""}`, async () => {
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
        versionBasis: basis,
        inferredVersionCandidate: {
          type: "inferred",
          kind: "decision_date",
          versionValidFrom: "2020-01-01",
        },
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
            <CitingDecisionItem
              decision={{ ...decision, versionBasis: basis }}
            />
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
            <FormattingProvider
              locale={formattingLocale}
              timeZone="Europe/Prague"
            >
              <router.RouterProvider router={appRouter} />
            </FormattingProvider>
          </IntlProvider>
        </QueryClientProvider>,
      );
      expect(
        ui.getByRole("link", { name: /1 C 1\/2020/u }).textContent,
      ).toContain(label);
      fireEvent.click(
        ui.getByRole("button", {
          name: messages.caseLaw.viewer.provisionsCited,
        }),
      );
      const panel =
        ui
          .getByRole("button", {
            name: messages.caseLaw.viewer.provisionsCited,
          })
          .closest("section") ?? ui.container;
      expect(
        panel.querySelector('[data-version-basis="group"]')?.textContent,
      ).toContain(compactLabel);
      expect(
        panel.querySelectorAll('[data-version-basis="exception"]'),
      ).toHaveLength(0);
      const chip = within(panel).getByRole("button", { name: "§ 13" });
      expect(chip.textContent).toBe("§ 13");
      chip.focus();
      await waitFor(() => {
        expect(
          ui.baseElement.querySelector('[data-slot="preview-card-content"]')
            ?.textContent,
        ).toContain(label);
      });
    });
  }
}
