import type { ComponentProps, ReactElement } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { noDecisionReviewFound } from "@stll/api-contract/case-law-reviews";
import {
  CHAT_STEP_LEDGER_KEY,
  type ChatStepLedger,
  type ChatStepRef,
} from "@stll/api-contract/chat-step-ledger";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";
import { createTestState } from "@stll/test-state";

import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import type { PresentationPrefs } from "@/lib/account/presentation-prefs/preferences";

GlobalRegistrator.register({
  url: "http://localhost:3000/chat",
  width: 1280,
  settings: {
    navigation: {
      disableMainFrameNavigation: true,
      disableChildFrameNavigation: true,
      disableChildPageNavigation: true,
      disableFallbackToSetURL: true,
    },
  },
});
const originalFetch = globalThis.fetch;
const idleFetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});
globalThis.fetch = idleFetch;
// Decisions open in stella only where public law is served.
const state = createTestState({ file: import.meta.path, config: {} });
state.setEnv("VITE_PUBLIC_LAW_ENABLED", "true");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { PresentationPrefsProvider } =
  await import("@/lib/account/presentation-prefs/provider");
const { defaultPresentationPrefs } =
  await import("@/lib/account/presentation-prefs/preferences");
const { createPresentationPrefsSync } =
  await import("@/lib/account/presentation-prefs/sync");
const { useInspectorTabsStore } =
  await import("@/components/inspector/inspector-tabs-store");
const { isCaseDecisionViewPayload } =
  await import("@/components/inspector/case-decision-view");
const { toSafeId } = await import("@/lib/safe-id");
const enMessages = (await import("@/i18n/langs/en.json")).default;
const csMessages = (await import("@/i18n/langs/cs.json")).default;
const { ToolCallCard } = await import("./tool-call-card");

const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(async () => {
  await act(async () => {
    cleanup();
    await Promise.all(clients.map(async (client) => client.cancelQueries()));
    clients.length = 0;
    useInspectorTabsStore.setState({ tabs: [], activeId: null });
    globalThis.fetch = idleFetch;
  });
});
afterAll(async () => {
  await act(async () => {});
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const DECISION_ID = "f46d5994-ab9f-5a53-8172-80d000959426";
const READER_URL =
  "http://localhost:3000/law/cze/cases/ustavni-soud/iii-us-2429-24";
const STATUTE_URL =
  "http://localhost:3000/law/cze/statutes/99-1963-sb-obcansky-soudni-rad#par_243f";
const SCRIPT =
  'const r = await external_search_case_law({country:"CZE", queries:["dovolání podané neoprávněnou osobou"]});\nreturn JSON.stringify(r).slice(0,9000);';

const decisionRef = (
  index: number,
  decisionId = `${String(index).padStart(8, "0")}-ab9f-5a53-8172-80d000959426`,
): ChatStepRef => ({
  type: "decision",
  decisionId,
  caseNumber: index === 0 ? "III.ÚS 2429/24" : `I.ÚS ${String(index)}/26`,
  court: "Ústavní soud",
  courtAbbreviation: "ÚS",
  country: "CZE",
  decisionDate: "2026-04-15",
  ecli: null,
  summary: "Rozhodnutí o dovolání má patřit senátu.",
  url:
    index === 0
      ? READER_URL
      : `http://localhost:3000/law/cze/cases/ustavni-soud/i-us-${String(index)}-26`,
  sourceUrl: null,
});

const LEDGER = {
  calls: [
    {
      tool: "search_case_law",
      queries: ["dovolání podané neoprávněnou osobou"],
      filters: [
        { kind: "country", value: "CZE" },
        { kind: "court", value: "ÚS" },
        { kind: "dateFrom", value: "2020-01-01" },
      ],
      outcome: "ok",
      found: [decisionRef(0, DECISION_ID)],
      foundOmitted: 0,
    },
    {
      tool: "read_statute_provisions",
      queries: [],
      filters: [],
      outcome: "ok",
      found: [
        {
          type: "statute",
          eli: "https://www.e-sbirka.cz/eli/cz/sb/1963/99",
          anchor: "par_243f",
          label: "§ 243f o. s. ř.",
          validFrom: "2026-01-01",
          validTo: null,
          url: STATUTE_URL,
          sourceUrl: null,
        },
      ],
      foundOmitted: 0,
    },
    {
      tool: "search_case_law",
      queries: ["zákonný soudce samosoudce"],
      filters: [{ kind: "court", value: "NS" }],
      outcome: "error",
      found: [],
      foundOmitted: 0,
    },
  ],
  callsOmitted: 0,
} satisfies ChatStepLedger;

type StepPart = ComponentProps<typeof ToolCallCard>["part"];

// What the script returned: its own serialization, cut off mid-record.
const TRUNCATED_RESULT = {
  logs: [],
  result:
    '{"results":[{"url":"http://localhost:3000/law/cze/cases/ustavni-soud/iii-us',
  success: true,
};

const codeStep = (
  ledger: ChatStepLedger | undefined,
  output: Record<string, unknown> = TRUNCATED_RESULT,
): StepPart => ({
  type: "tool-call",
  id: "code-step",
  name: "execute_typescript",
  arguments: JSON.stringify({ typescriptCode: SCRIPT }),
  input: { typescriptCode: SCRIPT },
  output:
    ledger === undefined
      ? output
      : { ...output, [CHAT_STEP_LEDGER_KEY]: ledger },
  state: "complete",
});

const citing = (decisionIds: readonly string[]) => ({
  appOrigins: new Set(["http://localhost:3000"]),
  decisionIds: new Set(decisionIds),
  hrefKeys: new Set<string>(),
});

const prefsSync = (prefs: PresentationPrefs) =>
  createPresentationPrefsSync({
    initialPrefs: prefs,
    read: async () => await Promise.resolve(prefs),
    write: async (patch) => await Promise.resolve({ ...prefs, ...patch }),
  });

const renderCard = async ({
  card,
  locale = "en",
  technical = false,
}: {
  card: ReactElement;
  locale?: "cs" | "en";
  technical?: boolean;
}) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const prefs = {
    ...defaultPresentationPrefs,
    chatTechnicalDetails: technical,
  };
  const root = router.createRootRoute({ component: router.Outlet });
  const page = router.createRoute({
    getParentRoute: () => root,
    path: "/chat",
    component: () => card,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/chat"] }),
    routeTree: root.addChildren([page]),
    isServer: false,
  });
  await appRouter.load();
  return render(
    <QueryClientProvider client={client}>
      <PresentationPrefsProvider initialPrefs={prefs} sync={prefsSync(prefs)}>
        <IntlProvider
          locale={locale}
          messages={locale === "cs" ? csMessages : enMessages}
          timeZone="UTC"
        >
          <FormattingProvider locale={locale} timeZone="UTC">
            <router.RouterProvider router={appRouter} />
          </FormattingProvider>
        </IntlProvider>
      </PresentationPrefsProvider>
    </QueryClientProvider>,
  );
};

const openStep = async (locale: "cs" | "en" = "en") => {
  const messages = locale === "cs" ? csMessages : enMessages;
  fireEvent.click(
    await screen.findByRole("button", {
      name: messages.chat.toolCall.toggleDetails,
    }),
  );
};

// What only a developer reads: the script, its function names, JSON.
const TECHNICAL_TEXT = [
  "external_search_case_law",
  "typescriptCode",
  "JSON.stringify",
  '{"results"',
  '"success"',
  "stepLedger",
];

const expectNoTechnicalText = (text: string) => {
  for (const fragment of TECHNICAL_TEXT) {
    expect(text.includes(fragment)).toBe(false);
  }
};

describe("an opened code step reads as research, not code", () => {
  test("it shows what was searched with its filters and what came back, with no code or raw result", async () => {
    const view = await renderCard({
      card: (
        <ToolCallCard
          activeOrganizationId="test-org"
          answerCitations={citing([DECISION_ID])}
          failureOutcome="recovered"
          part={codeStep(LEDGER)}
        />
      ),
    });
    await openStep();

    const text = view.container.textContent;
    expect(text).toContain("dovolání podané neoprávněnou osobou");
    // Each filter is a chip; "ÚS" is also the found decision's court.
    for (const chip of ["CZE", "ÚS", "From Jan 1, 2020", "NS"]) {
      expect(screen.getAllByText(chip).length).toBeGreaterThan(0);
    }
    expect(
      screen.getByText(
        "1 decision found, 1 used in the answer · 1 statute or provision",
      ),
    ).toBeDefined();
    expect(
      screen.getByText(enMessages.chat.stepDigest.usedInAnswer),
    ).toBeDefined();
    expect(
      screen.getByText(enMessages.chat.stepDigest.lookupDidNotGoThrough),
    ).toBeDefined();
    expect(screen.getByText("Version from Jan 1, 2026")).toBeDefined();

    // Each find opens where an inline citation opens it.
    const decision = screen.getByRole("link", { name: /III\.ÚS 2429\/24/u });
    expect(decision.getAttribute("href")).toBe(READER_URL);
    const provision = screen.getByRole("link", { name: /§ 243f o\. s\. ř\./u });
    expect(provision.getAttribute("href")).toBe(STATUTE_URL);

    expectNoTechnicalText(text);
    expect(
      screen.queryByRole("button", {
        name: enMessages.chat.stepDigest.technicalDetails,
      }),
    ).toBeNull();
  });

  test("a found decision opens in the side panel, as an inline citation does", async () => {
    const requests: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const pathname = new URL(request.url).pathname;
        requests.push(pathname);
        // Any other read is unexpected; it is recorded and fails the
        // assertion on `requests` below.
        return pathname.endsWith(`/case/decisions/${DECISION_ID}`)
          ? Response.json(DECISION)
          : Response.json(null, { status: 404 });
      },
      { preconnect: () => undefined },
    );
    await renderCard({
      card: (
        <ToolCallCard
          activeOrganizationId="test-org"
          failureOutcome="recovered"
          part={codeStep(LEDGER)}
        />
      ),
    });
    await openStep();
    fireEvent.click(screen.getByRole("link", { name: /III\.ÚS 2429\/24/u }));

    await waitFor(() => {
      expect(
        useInspectorTabsStore
          .getState()
          .tabs.flatMap((tab) =>
            tab.type === "view" && isCaseDecisionViewPayload(tab.payload)
              ? [tab.payload.decisionId]
              : [],
          ),
      ).toEqual([DECISION_ID]);
    });
    expect(
      requests.map((pathname) =>
        pathname.endsWith(`/case/decisions/${DECISION_ID}`),
      ),
    ).toEqual([true]);
  });

  test("Czech counts say how many decisions came back and how many the answer used", async () => {
    const found = Array.from({ length: 12 }, (_, index) => decisionRef(index));
    const cited = found
      .slice(0, 3)
      .flatMap((ref) => (ref.type === "decision" ? [ref.decisionId] : []));
    await renderCard({
      locale: "cs",
      card: (
        <ToolCallCard
          activeOrganizationId="test-org"
          answerCitations={citing(cited)}
          failureOutcome="recovered"
          part={codeStep({
            calls: [
              {
                tool: "search_case_law",
                queries: ["dovolání"],
                filters: [],
                outcome: "ok",
                found,
                foundOmitted: 0,
              },
            ],
            callsOmitted: 0,
          })}
        />
      ),
    });
    await openStep("cs");

    expect(
      screen.getByText("12 rozhodnutí nalezeno, 3 použita v odpovědi"),
    ).toBeDefined();
    expect(
      screen.getAllByText(csMessages.chat.stepDigest.usedInAnswer),
    ).toHaveLength(3);
  });

  test("a code step from before ledgers says so instead of showing its code", async () => {
    const view = await renderCard({
      card: (
        <ToolCallCard
          activeOrganizationId="test-org"
          failureOutcome="recovered"
          part={codeStep(undefined)}
        />
      ),
    });
    await openStep();

    expect(
      screen.getByText(enMessages.chat.stepDigest.notRecorded),
    ).toBeDefined();
    expectNoTechnicalText(view.container.textContent);
  });
});

describe("the technical details setting", () => {
  test("keeps today's code and output behind a collapsed section", async () => {
    const view = await renderCard({
      technical: true,
      card: (
        <ToolCallCard
          activeOrganizationId="test-org"
          failureOutcome="recovered"
          part={codeStep(LEDGER)}
        />
      ),
    });
    await openStep();

    // The digest still leads; the section starts collapsed.
    expect(view.container.textContent).toContain(
      "dovolání podané neoprávněnou osobou",
    );
    expect(
      view.container.textContent.includes("external_search_case_law"),
    ).toBe(false);

    fireEvent.click(
      screen.getByRole("button", {
        name: enMessages.chat.stepDigest.technicalDetails,
      }),
    );

    const text = view.container.textContent;
    expect(text).toContain("external_search_case_law");
    expect(text).toContain('"success": true');
    // The ledger is the digest above, not part of the raw result.
    expect(text.includes(CHAT_STEP_LEDGER_KEY)).toBe(false);
  });

  test("a failed step says what did not go through in a quiet line, and its raw error only with the setting", async () => {
    const failed = codeStep(
      {
        calls: [
          {
            tool: "search_case_law",
            queries: ["indemnity cap carve-outs"],
            filters: [],
            outcome: "error",
            found: [],
            foundOmitted: 0,
          },
        ],
        callsOmitted: 0,
      },
      {
        error: { message: "TypeError: r.results is undefined at line 2" },
        logs: [],
        success: false,
      },
    );
    for (const technical of [false, true]) {
      const view = await renderCard({
        technical,
        card: (
          <ToolCallCard
            activeOrganizationId="test-org"
            failureOutcome="terminal"
            part={failed}
          />
        ),
      });
      await openStep();

      // The mark names the failure; the step body draws no red and no
      // per-step failure line.
      expect(
        screen.getByRole("img", { name: enMessages.chat.toolCall.failed }),
      ).toBeDefined();
      expect(
        view.container.textContent.includes(enMessages.chat.toolCall.failed),
      ).toBe(false);
      const notThrough = screen.getByText(
        enMessages.chat.stepDigest.lookupDidNotGoThrough,
      );
      expect(notThrough.className.includes("text-muted-foreground")).toBe(true);
      expect(
        view.container.querySelectorAll("[data-step-digest] .text-destructive"),
      ).toHaveLength(0);
      const technicalToggle = screen.queryByRole("button", {
        name: enMessages.chat.stepDigest.technicalDetails,
      });
      expect(technicalToggle !== null).toBe(technical);
      if (technicalToggle !== null) {
        fireEvent.click(technicalToggle);
        expect(view.container.textContent.includes("TypeError")).toBe(true);
      } else {
        expect(view.container.textContent.includes("TypeError")).toBe(false);
      }
      view.unmount();
    }
  });
});

const absentText = { type: "absent", reason: "not_published" } as const;
const DECISION = {
  appealReviews: noDecisionReviewFound(),
  extractionWarnings: [],
  citationCount: 0,
  id: toSafeId<"caseLawDecision">(DECISION_ID),
  caseNumber: "III.ÚS 2429/24",
  caseNumberType: "case-number",
  country: "CZE",
  court: "Ústavní soud",
  courtId: null,
  courtAbbreviation: "ÚS",
  courtTier: "constitutional",
  decisionDate: "2026-04-15",
  decisionType: null,
  ecli: null,
  language: "cs",
  caseFile: { items: [], nextCursor: null, limit: 50 },
  languageAlternates: [],
  languageGroupKey: null,
  slug: null,
  citationsFrom: [],
  citationsTo: [],
  citationsNextCursor: null,
  createdAt: "2026-04-15T00:00:00.000Z",
  updatedAt: "2026-04-15T00:00:00.000Z",
  documentAst: null,
  documentAstSource: null,
  projectionDigest: null,
  hasDocument: false,
  documentPending: false,
  documentReadFailed: false,
  documentUnavailable: false,
  textIncompleteReason: null,
  textWithheldReason: null,
  documentUrl: null,
  fulltext: null,
  headnote: absentText,
  identifiers: [{ type: "case-number", value: "III.ÚS 2429/24" }],
  judges: [],
  metadata: {},
  sections: null,
  resolution: { type: "direct" },
  source: {
    adapterKey: "synthetic",
    allowsDerivedAi: false,
    id: toSafeId<"caseLawSource">("00000000-0000-4000-8000-000000000002"),
    name: "Synthetic source",
  },
  sourceAttributionUrl: null,
  sourceLanguages: null,
  sourceUrl: null,
  textFields: {
    abstract: absentText,
    headnote: absentText,
    legalSentence: absentText,
    summary: absentText,
  },
} satisfies PublicCaseLawDecision;
