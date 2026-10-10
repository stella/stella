import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { DECISION_DATE_VERSION_BASIS } from "@stll/api-contract/provision-version-basis";
import { sleep } from "@stll/concurrency/sleep";

import { toSafeId } from "@/lib/safe-id";

import type { CitingDecisionRow } from "./provision-citing-decisions";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { buildFormattingLocale } = await import("@/i18n/i18n-store");
const { CitingDecisionItem } = await import("./citing-decision-item");
const { caseDecisionTabId, isCaseDecisionGenericTab } =
  await import("@/components/inspector/case-decision-view");
const { useInspectorTabsStore } =
  await import("@/components/inspector/inspector-tabs-store");
const en = (await import("@/i18n/langs/en.json")).default;
const ar = (await import("@/i18n/langs/ar.json")).default;
const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(() => {
  cleanup();
  useInspectorTabsStore.getState().closeTab(caseDecisionTabId(decisionId));
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});
afterAll(async () => {
  cleanup();
  await act(async () => {
    await sleep(0);
  });
  await GlobalRegistrator.unregister();
});

const createClient = () => {
  const client = new QueryClient();
  clients.push(client);
  return client;
};

const decisionId = toSafeId<"caseLawDecision">(
  "00000000-0000-4000-8000-000000000001",
);
const decision = {
  decisionId,
  caseNumber: "1 C 1/2020",
  country: "CZE",
  court: "Supreme Court",
  courtAbbreviation: "SC",
  sourceUrl: null,
  courtTier: "supreme",
  citationAuthority: 1,
  language: "cs",
  languageAlternates: [],
  slug: "decision",
  decisionDate: "2020-01-01",
  mentionCount: 3,
  sentenceText:
    "A 😀 sentence cites § 13 and explains the decision. It continues with a second sentence.",
  snippetCitation: { start: 20, end: 24 },
  spanStart: 0,
  spanEnd: 4,
  versionBasis: DECISION_DATE_VERSION_BASIS,
  versionValidFrom: "2018-01-01",
  inferredVersionCandidate: {
    type: "inferred",
    kind: "decision_date",
    versionValidFrom: "2018-01-01",
  },
} satisfies CitingDecisionRow;

for (const [locale, messages, localizedThree] of [
  ["en", en, "3"],
  ["ar", ar, "٣"],
] as const) {
  test(`${locale}: citing row highlights and expands its UTF-16 citation`, async () => {
    const formattingLocale = buildFormattingLocale({
      lang: locale,
      region: "",
      regionalFormat: "auto",
      calendar: "auto",
      numberingSystem: "auto",
      weekStart: "auto",
    });
    const client = createClient();
    const root = router.createRootRoute({
      component: () => (
        <CitingDecisionItem
          currentVersionValidFrom="2022-01-01"
          decision={decision}
        />
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
        <IntlProvider locale={locale} messages={messages} timeZone="UTC">
          <FormattingProvider locale={formattingLocale} timeZone="UTC">
            <router.RouterProvider router={appRouter} />
          </FormattingProvider>
        </IntlProvider>
      </QueryClientProvider>,
    );

    expect(ui.getByRole("button", { name: /1 C 1\/2020/u })).toBeTruthy();
    const row = ui.container;
    expect(row.textContent).toContain(localizedThree);
    expect(row.textContent).toContain("×");
    expect(row.querySelector("mark")?.textContent).toBe("§ 13");
    expect(row.querySelector("a button")).toBeNull();
    expect(
      ui.getByRole("button", {
        name: messages.statutes.citingDecisionOlderVersion,
      }),
    ).toBeTruthy();
    expect(row.querySelector(".line-clamp-2")).not.toBeNull();

    const expandButton = ui.getByRole("button", {
      name: messages.statutes.citingDecisionShowSnippet,
    });
    expect(expandButton.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(expandButton);
    expect(row.querySelector(".line-clamp-2")).toBeNull();
    expect(row.textContent).toContain("second sentence");
    expect(
      ui
        .getByRole("button", {
          name: messages.statutes.citingDecisionHideSnippet,
        })
        .getAttribute("aria-expanded"),
    ).toBe("true");

    cleanup();
    client.clear();
  });
}

for (const { label, basis, versionValidFrom, currentVersionValidFrom } of [
  {
    label: "not stated basis",
    basis: { type: "not_stated" } as const,
    versionValidFrom: null,
    currentVersionValidFrom: "2022-01-01",
  },
  {
    label: "unresolved stated date",
    basis: {
      type: "stated_date",
      date: "2018-01-01",
      relation: "until",
      expression: null,
      evidence: { kind: "stated_date", start: 0, end: 1 },
    } as const,
    versionValidFrom: null,
    currentVersionValidFrom: "2022-01-01",
  },
  {
    label: "missing inferred candidate",
    basis: DECISION_DATE_VERSION_BASIS,
    versionValidFrom: null,
    currentVersionValidFrom: "2022-01-01",
  },
  {
    label: "same version",
    basis: DECISION_DATE_VERSION_BASIS,
    versionValidFrom: "2022-01-01",
    currentVersionValidFrom: "2022-01-01",
  },
  {
    label: "unknown current version",
    basis: DECISION_DATE_VERSION_BASIS,
    versionValidFrom: "2018-01-01",
    currentVersionValidFrom: null,
  },
]) {
  test(`does not mark an older version for ${label}`, async () => {
    const client = createClient();
    const root = router.createRootRoute({
      component: () => (
        <CitingDecisionItem
          currentVersionValidFrom={currentVersionValidFrom}
          decision={{
            ...decision,
            versionBasis: basis,
            versionValidFrom,
            inferredVersionCandidate: {
              ...decision.inferredVersionCandidate,
              versionValidFrom:
                label === "missing inferred candidate"
                  ? null
                  : versionValidFrom,
            },
          }}
        />
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
        <IntlProvider locale="en" messages={en} timeZone="UTC">
          <FormattingProvider
            locale={buildFormattingLocale({
              lang: "en",
              region: "",
              regionalFormat: "auto",
              calendar: "auto",
              numberingSystem: "auto",
              weekStart: "auto",
            })}
            timeZone="UTC"
          >
            <router.RouterProvider router={appRouter} />
          </FormattingProvider>
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(ui.queryByText(en.statutes.citingDecisionOlderVersion)).toBeNull();
  });
}

test("opens a citing decision at its excerpt", async () => {
  const client = createClient();
  const root = router.createRootRoute({
    component: () => (
      <CitingDecisionItem currentVersionValidFrom={null} decision={decision} />
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
      <IntlProvider locale="en" messages={en} timeZone="UTC">
        <FormattingProvider
          locale={buildFormattingLocale({
            lang: "en",
            region: "",
            regionalFormat: "auto",
            calendar: "auto",
            numberingSystem: "auto",
            weekStart: "auto",
          })}
          timeZone="UTC"
        >
          <router.RouterProvider router={appRouter} />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  fireEvent.focus(ui.getByRole("button", { name: /1 C 1\/2020/u }));
  const open = await ui.findByRole("link", { name: en.common.openInStella });
  expect(
    new URL(
      open.getAttribute("href") ?? "",
      window.location.origin,
    ).searchParams.get("q"),
  ).toBe(decision.sentenceText);
  fireEvent.click(open);
  await waitFor(() => {
    const opened = useInspectorTabsStore
      .getState()
      .tabs.filter(isCaseDecisionGenericTab);
    expect(opened).toHaveLength(1);
    expect(opened.at(0)?.payload).toMatchObject({
      decisionId,
      searchQuery: decision.sentenceText,
    });
  });
});
