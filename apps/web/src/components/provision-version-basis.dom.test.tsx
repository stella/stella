import type { ComponentProps } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import { STATED_DATE_RELATIONS } from "@stll/api-contract/provision-applied-version";
import { DECISION_DATE_VERSION_BASIS } from "@stll/api-contract/provision-version-basis";
import type { ProvisionVersionBasis } from "@stll/api-contract/provision-version-basis";
import { sleep } from "@stll/concurrency/sleep";

import { toSafeId } from "@/lib/safe-id";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
const { act, cleanup, render, fireEvent, within, waitFor } =
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
const { ProvisionVersionBasisLabel } =
  await import("./provision-version-basis");
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
  cleanup();
  // Let React's scheduled work drain before the DOM goes away.
  await act(async () => {
    await sleep(50);
  });
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
  courtTier: "supreme",
  mentionCount: 1,
  snippetCitation: null,
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
          appliedVersionStatedAmendmentCompact:
            messages.caseLaw.viewer.appliedVersionStatedAmendmentCompact,
          appliedVersionStatedDateCompact:
            messages.caseLaw.viewer.appliedVersionStatedDateCompact,
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
      label: translate.markup("caseLaw.viewer.appliedVersionStatedAmendment", {
        amendment: "303/2013 Sb.",
        reference: (chunks) => chunks,
      }),
      compactLabel: translate.markup(
        "caseLaw.viewer.appliedVersionStatedAmendmentCompact",
        {
          amendment: "303/2013 Sb.",
          reference: (chunks) => chunks,
        },
      ),
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
          compactLabel: translate(
            "caseLaw.viewer.appliedVersionStatedDateCompact",
            {
              date: formatDate("2014-01-01"),
              relation,
            },
          ),
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
              currentVersionValidFrom={null}
              decision={{ ...decision, versionBasis: basis }}
            />
            <ProvisionVersionBasisLabel basis={basis} />
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
      const href = chip.getAttribute("href");
      expect(href).not.toBeNull();
      if (href === null) {
        panic("Missing decision reader link");
      }
      const target = new URL(href);
      expect(`${target.origin}${target.pathname}`).toBe(readerUrl);
      expect(target.searchParams.get("q")).toBe(decision.sentenceText);
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
      const panel =
        ui
          .getByRole("button", {
            name: messages.caseLaw.viewer.provisionsCited,
          })
          .closest("section") ?? ui.container;
      expect(
        panel.querySelector('[data-version-basis="group"]')?.textContent,
      ).toBe(compactLabel);
      if (basis.type === "stated_version") {
        // A mixed-direction act identifier keeps its own order inside RTL copy.
        expect(
          panel.querySelector('[data-version-basis="group"] bdi')?.textContent,
        ).toBe(basis.amendmentWorkIdentifier);
      }
      expect(
        panel.querySelectorAll('[data-version-basis="exception"]'),
      ).toHaveLength(0);
      const provisionChip = within(panel).getByRole("button", { name: "§ 13" });
      expect(provisionChip.textContent).toBe("§ 13");
      provisionChip.focus();
      await waitFor(() => {
        expect(
          ui.baseElement.querySelector('[data-slot="preview-card-content"]')
            ?.textContent,
        ).toContain(label);
      });
      // A pointer click lands after the focus that opened the preview.
      fireEvent.click(provisionChip);
      await act(async () => {
        await sleep(0);
      });
      expect(
        ui.baseElement.querySelector('[data-slot="preview-card-content"]')
          ?.textContent,
      ).toContain(label);
    });
  }
}
