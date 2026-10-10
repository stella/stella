import type { ComponentProps } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import { STATED_DATE_RELATIONS } from "@stll/api-contract/provision-applied-version";
import { DECISION_DATE_VERSION_BASIS } from "@stll/api-contract/provision-version-basis";
import type { ProvisionVersionBasis } from "@stll/api-contract/provision-version-basis";

import { toSafeId } from "@/lib/safe-id";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
const { act, cleanup, render, fireEvent, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider, createTranslator } = await import("use-intl");
const { env } = await import("@/env");
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
afterEach(async () => {
  await act(async () => {
    cleanup();
    for (const client of clients) {
      client.clear();
    }
    clients.length = 0;
  });
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
  courtAbbreviation: null,
  sourceUrl: null,
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

for (const [locale, messages] of [
  ["en", en],
  ["ar", ar],
] as const) {
  const formattingLocale = buildFormattingLocale({
    lang: locale,
    region: "",
    regionalFormat: "auto",
    calendar: "auto",
    numberingSystem: "auto",
    weekStart: "auto",
  });
  const translate = createTranslator({
    locale,
    messages: {
      caseLaw: {
        citation: {
          referenceLabel: messages.caseLaw.citation.referenceLabel,
        },
        viewer: {
          appliedVersionStatedAmendment:
            messages.caseLaw.viewer.appliedVersionStatedAmendment,
          appliedVersionStatedDate:
            messages.caseLaw.viewer.appliedVersionStatedDate,
        },
      },
    },
  });
  const formatDate = (date: string) =>
    new Intl.DateTimeFormat(formattingLocale, {
      dateStyle: "medium",
      timeZone: "UTC",
    }).format(new Date(`${date}T00:00:00Z`));
  const reference = translate("caseLaw.citation.referenceLabel", {
    court: decision.court,
    caseNumber: decision.caseNumber,
    date: formatDate(decision.decisionDate),
  });
  const readerUrl = new URL(
    createCaseLawDecisionPath(
      createCaseLawDecisionRouteParams({
        caseNumber: decision.caseNumber,
        country: decision.country,
        court: decision.court,
        decisionId: decision.decisionId,
        language: decision.language,
        languageAlternates: decision.languageAlternates,
        slug: decision.slug,
      }),
    ),
    env.VITE_PUBLIC_APP_URL,
  ).href;
  const cases = [
    {
      basis: DECISION_DATE_VERSION_BASIS,
      label: messages.caseLaw.viewer.versionAtDecisionDateInferred,
    },
    {
      basis: { type: "not_stated" },
      label: messages.caseLaw.viewer.appliedVersionNotStated,
    },
    {
      basis: {
        type: "stated_version",
        amendmentWorkIdentifier: "303/2013 Sb.",
        expression: null,
        evidence: { kind: "stated_version", start: 0, end: 10 },
      },
      label: translate.markup("caseLaw.viewer.appliedVersionStatedAmendment", {
        amendment: "303/2013 Sb.",
        reference: (chunks) => chunks,
      }),
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
          label: translate("caseLaw.viewer.appliedVersionStatedDate", {
            date: formatDate("2014-01-01"),
            relation,
          }),
        }) as const,
    ),
  ] as const satisfies readonly {
    basis: ProvisionVersionBasis;
    label: string;
  }[];
  for (const { basis, label } of cases) {
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
      const chip = ui.getByRole("button", { name: reference });
      expect(chip.getAttribute("href")).toBe(readerUrl);
      expect(chip.textContent).not.toContain(label);
      const citingBasis = ui.getByText(
        (_, element) =>
          element !== null &&
          element.classList.contains("text-2xs") &&
          element.textContent === label,
      );
      expect(citingBasis.textContent).toBe(label);
      expect(chip.contains(citingBasis)).toBe(false);
      fireEvent.click(
        ui.getByRole("button", {
          name: messages.caseLaw.viewer.provisionsCited,
        }),
      );
      expect(
        ui.getAllByText(
          (_, element) =>
            element !== null &&
            element.classList.contains("text-2xs") &&
            element.textContent === label,
        ),
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
      ).toContain(label);
    });
  }
}
