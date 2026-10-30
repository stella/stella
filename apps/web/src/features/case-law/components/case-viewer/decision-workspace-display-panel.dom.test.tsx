import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { unregisterDomEnvironment } from "@/test-dom-environment";

import { provision } from "./provisions-cited.fixture";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).pathname === "/api/auth/get-session") {
      return Response.json(null);
    }
    return originalFetch(input, init);
  },
  { preconnect: originalFetch.preconnect },
);

const { cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { ChromeHeaderActionsSlot } = await import("@/lib/chrome-header-actions");
const { browserStorage } = await import("@/lib/account/browser-storage");
const { decisionProvisionsForLinkingOptions, statutesResolveOptions } =
  await import("@/features/case-law/queries/provisions");
const { provisionPreviewOptions } =
  await import("@/lib/statutes/provision-preview");
const { toSafeId } = await import("@/lib/safe-id");
const { DecisionWorkspace } = await import("./decision-workspace");
const { dockedChatLegalPayloads } =
  await import("../../../../../e2e/helpers/docked-chat-legal-payloads");
const { default: messages } = await import("@/i18n/langs/en.json");

const clients: InstanceType<typeof QueryClient>[] = [];
const originalRect = HTMLElement.prototype.getBoundingClientRect;

afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  browserStorage("local")?.clear();
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const sentence = "Dovolání se opírá o § 265b odst. 1 trestního řádu.";
const workEli = "/eli/cz/sb/1961/141";
const ast = {
  version: 1,
  source: { documentId: "1", printUrl: "", system: "test", webUrl: "" },
  metadata: {
    caseNumber: "SYN 1/2026",
    court: "Synthetic court",
    decisionDate: null,
    decisionType: "Judgment",
    ecli: null,
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      id: "p-1",
      anchorId: "p-1",
      type: "paragraph",
      plainText: sentence,
      inlines: [{ type: "text", text: sentence }],
    },
  ],
} satisfies DocumentAst;
const decision = { ...dockedChatLegalPayloads.decision, documentAst: ast };
const statuteId = toSafeId<"legislationDocument">(
  "00000000-0000-4000-8000-000000000003",
);

type LinkingRead = Awaited<
  ReturnType<
    NonNullable<
      ReturnType<typeof decisionProvisionsForLinkingOptions>["queryFn"]
    >
  >
>;
type ResolvedWorks = Awaited<
  ReturnType<NonNullable<ReturnType<typeof statutesResolveOptions>["queryFn"]>>
>;

/** The decision cites one provision of an act the corpus holds. */
const seedCitedProvision = (client: InstanceType<typeof QueryClient>) => {
  client.setQueryData(
    decisionProvisionsForLinkingOptions(decision.id).queryKey,
    {
      items: [provision({ sentenceText: sentence, workEli })],
      nextCursor: null,
      previews: [],
      status: { type: "current" },
      generation: "0",
    } satisfies LinkingRead,
  );
  const work = { asOf: decision.decisionDate, country: "CZE", eli: workEli };
  // The consolidation carries no wording for the card to quote.
  client.setQueryData(
    provisionPreviewOptions({
      anchor: "s265b",
      citedAnchor: "s265b",
      documentId: statuteId,
    }).queryKey,
    null,
  );
  client.setQueryData(statutesResolveOptions([work]).queryKey, [
    {
      ...work,
      unresolvedReason: null,
      statute: {
        country: "CZE",
        eli: workEli,
        id: statuteId,
        language: "cs",
        slug: "141-1961-sb",
        title: "141/1961 Sb., trestní řád",
        versionValidFrom: "1961-01-01",
        versionValidTo: null,
        expressionKind: "consolidation",
        windowDisposition: "effective",
      },
    },
  ] satisfies ResolvedWorks);
};

/** Happy DOM lays nothing out: give the margin column the width `lg` does. */
const layOutMarginColumn = () => {
  HTMLElement.prototype.getBoundingClientRect = function () {
    return this.matches("[data-reader-notes-column]")
      ? new DOMRect(0, 0, 300, 1200)
      : new DOMRect(0, 0, 1000, 400);
  };
};

const renderReader = async () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { enabled: false, gcTime: Infinity, retry: false },
    },
  });
  clients.push(client);
  seedCitedProvision(client);
  const root = createRootRoute({
    component: () => (
      <>
        <header>
          <ChromeHeaderActionsSlot />
        </header>
        <DecisionWorkspace
          aiMode="gated"
          decision={decision}
          decisionId={decision.id}
        />
      </>
    ),
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root,
  });
  await router.load();
  return render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <TooltipProvider>
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </TooltipProvider>
      </FormattingProvider>
    </IntlProvider>,
  );
};

const marginCards = (container: HTMLElement) =>
  container.querySelectorAll(
    '[data-reader-notes-column] [data-slot="provision-card"]',
  );

test("the margin's display panel owns the cited provisions toggle", async () => {
  layOutMarginColumn();
  const view = await renderReader();
  const toggle = await view.findByRole("button", {
    name: messages.caseLaw.viewer.provisionsCited,
  });
  const panel = toggle.parentElement ?? panic("The toggle must sit in a panel");

  // The provisions follow the panel's three source filters, in tab order.
  expect(
    within(panel)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual([
    messages.common.all,
    messages.caseLaw.notesFilter.ai,
    messages.inbox.filter.mine,
    messages.caseLaw.viewer.provisionsCited,
  ]);
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(marginCards(view.container)).toHaveLength(0);
  // The chrome header publishes nothing once the margin holds the toggle.
  expect(within(screen.getByRole("banner")).queryAllByRole("button")).toEqual(
    [],
  );
  expect(
    view.queryByRole("button", {
      name: messages.caseLaw.reader.expandProvisions,
    }),
  ).toBeNull();

  fireEvent.click(toggle);

  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  await waitFor(() => expect(marginCards(view.container)).toHaveLength(1));

  fireEvent.click(toggle);

  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(marginCards(view.container)).toHaveLength(0);
});
