import type { ReactElement } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";

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
const originalPublicLawFlag = process.env["VITE_PUBLIC_LAW_ENABLED"];
process.env["VITE_PUBLIC_LAW_ENABLED"] = "true";
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { decisionOptions } =
  await import("@/features/case-law/queries/decisions");
const { toSafeId } = await import("@/lib/safe-id");
const { BidiText } = await import("@stll/ui/bidi-text");
const messages = (await import("@/i18n/langs/en.json")).default;
const { env } = await import("@/env");
const { createStatutePath, createStatuteRouteParams } =
  await import("@stll/api-contract/statute-route");
const { createCaseLawDecisionPath, createCaseLawDecisionRouteParams } =
  await import("@stll/api-contract/case-law-decision-route");
const { SourceChips } = await import("./source-chips");
const { StreamdownMentionLink } = await import("./streamdown-mention-link");
const { messageComponents } =
  await import("@/components/ai-elements/message-response-components");
const { AskUserCard } = await import("./ask-user-card");
const { useExternalSourceStore } = await import("./external-source-store");
const { useInspectorTabsStore } =
  await import("@/components/inspector/inspector-tabs-store");

const { createCaseDecisionViewTab, isCaseDecisionViewPayload } =
  await import("@/components/inspector/case-decision-view");

const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(async () => {
  await act(async () => {
    cleanup();
    await Promise.all(clients.map((client) => client.cancelQueries()));
    for (const client of clients) {
      client.clear();
    }
    clients.length = 0;
    useExternalSourceStore.setState({ sourcesByUrl: {} });
    useInspectorTabsStore.setState({ tabs: [], activeId: null });
    globalThis.fetch = idleFetch;
  });
});
afterAll(async () => {
  await act(async () => {});
  globalThis.fetch = originalFetch;
  if (originalPublicLawFlag === undefined) {
    delete process.env["VITE_PUBLIC_LAW_ENABLED"];
  } else {
    process.env["VITE_PUBLIC_LAW_ENABLED"] = originalPublicLawFlag;
  }
  await GlobalRegistrator.unregister();
});

const renderChat = async (
  children: ReactElement,
  cachedDecision?: PublicCaseLawDecision,
) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  if (cachedDecision !== undefined) {
    client.setQueryData(
      decisionOptions(cachedDecision.id).queryKey,
      cachedDecision,
    );
  }
  const root = router.createRootRoute({ component: router.Outlet });
  const page = router.createRoute({
    getParentRoute: () => root,
    path: "/chat",
    component: () => children,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/chat"] }),
    routeTree: root.addChildren([page]),
    isServer: false,
  });
  await appRouter.load();
  return render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <router.RouterProvider router={appRouter} />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

const documentId = "019dd47d-f507-7c84-b827-980af11b8980";
const statutePath = createStatutePath(
  createStatuteRouteParams({
    country: "cze",
    documentId,
    eli: "/eli/cz/sb/2012/89",
    slug: "89-2012-sb-obcansky-zakonik",
    version: null,
  }),
);
const decisionPath = createCaseLawDecisionPath(
  createCaseLawDecisionRouteParams({
    caseNumber: "26 Cdo 4249/2016",
    country: "cze",
    court: "Nejvyšší soud",
    decisionId: documentId,
    language: null,
    languageAlternates: null,
    slug: null,
  }),
);
const absentText = { type: "absent", reason: "not_published" } as const;
const fullDecision = {
  id: toSafeId<"caseLawDecision">(documentId),
  caseNumber: "26 Cdo 4249/2016",
  caseNumberType: "case-number",
  country: "CZE",
  court: "Nejvyšší soud",
  courtAbbreviation: "NS",
  courtTier: "supreme",
  decisionDate: "2017-01-12",
  decisionType: null,
  ecli: null,
  language: "cs",
  languageAlternates: [],
  languageGroupKey: null,
  slug: null,
  citationsFrom: [],
  citationsTo: [],
  citationsNextCursor: null,
  createdAt: "2017-01-12T00:00:00.000Z",
  updatedAt: "2017-01-12T00:00:00.000Z",
  documentAst: null,
  documentAstSource: null,
  projectionDigest: null,
  hasDocument: false,
  documentPending: false,
  documentReadFailed: false,
  documentUnavailable: false,
  documentUrl: null,
  fulltext: null,
  headnote: absentText,
  identifiers: [{ type: "case-number", value: "26 Cdo 4249/2016" }],
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
  sourceUrl: "https://publisher.example.test/decision",
  textFields: {
    abstract: absentText,
    headnote: absentText,
    legalSentence: absentText,
    summary: absentText,
  },
} satisfies PublicCaseLawDecision;
const quotedPassage = "The court preserves the remedy.";
const decisionReference = "Nejvyšší soud, 26 Cdo 4249/2016, Jan 12, 2017";

const citations = [
  { kind: "statute", path: statutePath },
  { kind: "provision", path: `${statutePath}#par-420` },
];

for (const { kind, path } of citations) {
  for (const held of [false, true]) {
    for (const interactive of [false, true]) {
      test(`${held ? "held" : "unheld"} ${kind} has the same primary on the tray and ${interactive ? "interactive" : "passive"} answer`, async () => {
        const publisher = `https://publisher.example.test/${kind}`;
        const internal = new URL(path, window.location.origin).href;
        const title = `Cited ${kind}`;
        const requests: string[] = [];
        globalThis.fetch = Object.assign(
          async (input: string | URL | Request) => {
            requests.push(
              input instanceof Request ? input.url : input.toString(),
            );
            return Response.json(null);
          },
          { preconnect: () => undefined },
        );
        const view = await renderChat(
          <>
            <section aria-label="Sources">
              <SourceChips
                activeOrganizationId="organization"
                messageId="message"
                parts={[
                  {
                    type: "tool-call",
                    id: "legal-search",
                    name: "execute_typescript",
                    state: "complete",
                    arguments: "{}",
                    output: {
                      title,
                      appUrl: held ? internal : null,
                      sourceUrl: publisher,
                    },
                  },
                ]}
              />
            </section>
            <section aria-label="Answer">
              <StreamdownMentionLink href={publisher} interactive={interactive}>
                {title}
              </StreamdownMentionLink>
            </section>
          </>,
        );
        const sources = view.getByRole("region", { name: "Sources" });
        const answer = view.getByRole("region", { name: "Answer" });
        await waitFor(() => {
          for (const surface of [sources, answer]) {
            const primary = surface.querySelector("a");
            expect(primary?.getAttribute("href")).toBe(
              held ? internal : publisher,
            );
            const links = [...surface.querySelectorAll("a")];
            expect(links).toHaveLength(held ? 2 : 1);
            if (held) {
              const source = links.at(1);
              expect(source?.textContent).toBe(messages.common.source);
              expect(source?.getAttribute("href")).toBe(publisher);
              expect(source?.getAttribute("target")).toBe("_blank");
              expect(source?.getAttribute("rel")).toBe("noopener noreferrer");
            }
          }
        });
        expect(view.container.querySelector("a a, a button")).toBeNull();
        expect(view.container.querySelector("img")).toBeNull();
        expect(requests).toEqual([]);
        const primary = answer.querySelector("a");
        expect(primary).not.toBeNull();
        const modified = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          metaKey: true,
        });
        primary?.dispatchEvent(modified);
        expect(modified.defaultPrevented).toBe(false);
      });
    }
  }
}

test("held decision tray and answer share a compact annotation without moving the quotation into the chip", async () => {
  const internal = new URL(decisionPath, window.location.origin).href;
  const publisher = fullDecision.sourceUrl;
  const view = await renderChat(
    <>
      <section aria-label="Sources">
        <SourceChips
          activeOrganizationId="organization"
          messageId="message"
          parts={[
            {
              type: "tool-call",
              id: "decision-search",
              name: "execute_typescript",
              state: "complete",
              arguments: "{}",
              output: {
                title: quotedPassage,
                appUrl: internal,
                sourceUrl: publisher,
                caseLawDecision: {
                  decisionId: documentId,
                  caseNumber: fullDecision.caseNumber,
                },
              },
            },
          ]}
        />
      </section>
      <section aria-label="Answer">
        <StreamdownMentionLink href={publisher} interactive>
          {quotedPassage}
        </StreamdownMentionLink>
      </section>
    </>,
    fullDecision,
  );
  const sources = view.getByRole("region", { name: "Sources" });
  const answer = view.getByRole("region", { name: "Answer" });
  await waitFor(() => {
    for (const surface of [sources, answer]) {
      const chip = surface.querySelector("[data-decision-citation]");
      expect(chip?.textContent).toBe("NS");
      expect(chip?.getAttribute("aria-label")).toBe(decisionReference);
      expect(chip?.textContent).not.toContain(quotedPassage);
    }
  });
  expect(answer.textContent).toBe(`${quotedPassage}NS`);
  expect(sources.textContent).not.toContain(quotedPassage);
  expect(view.container.querySelector("a a, a button")).toBeNull();
});

test("default markdown and clarification analysis share publisher aliases and internal primary links", async () => {
  const publisher = "https://publisher.example.test/provision";
  const internal = new URL(`${statutePath}#par-420`, window.location.origin)
    .href;
  useExternalSourceStore.getState().registerSources([
    {
      title: "Provision",
      url: publisher,
      appUrl: internal,
      sourceUrl: publisher,
    },
  ]);
  const analysis = `[Provision](${publisher})`;
  const input = {
    analysis,
    questions: [{ question: "Continue?", reason: "Confirm the reading." }],
  };
  const view = await renderChat(
    <>
      <section aria-label="Preview">
        {messageComponents.a({ href: publisher, children: "Provision" })}
      </section>
      <AskUserCard
        isAwaitingUser
        onSubmit={() => undefined}
        part={{
          type: "tool-call",
          name: "ask-user",
          id: "ask",
          state: "input-complete",
          arguments: JSON.stringify(input),
          input,
        }}
      />
    </>,
  );
  await waitFor(() => {
    const primaries = [...view.getAllByRole("link", { name: "Provision" })];
    expect(primaries).toHaveLength(2);
    for (const primary of primaries) {
      expect(primary.getAttribute("href")).toBe(internal);
    }
    expect(
      view.getAllByRole("link", { name: messages.common.source }),
    ).toHaveLength(2);
  });
});

test("an external primary still previews its publisher in the inspector on plain activation", async () => {
  const label = "Unheld citation";
  const publisher = "https://publisher.example.test/unheld";
  const view = await renderChat(
    <StreamdownMentionLink href={publisher} interactive>
      {label}
    </StreamdownMentionLink>,
  );
  const primary = view.getByRole("link", { name: label });
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  primary.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(
    useInspectorTabsStore
      .getState()
      .tabs.some((tab) => tab.type === "external" && tab.url === publisher),
  ).toBe(true);
});

for (const anchorId of [null, "p-12"]) {
  test(`a native decision ${anchorId === null ? "reference" : "passage"} keeps its source and inspector anchor`, async () => {
    const publisher = "https://publisher.example.test/decision";
    const internal = new URL(decisionPath, window.location.origin).href;
    const target = {
      caseNumber: "26 Cdo 4249/2016",
      country: "cze",
      court: "Nejvyšší soud",
      decisionId: documentId,
      language: null,
      languageAlternates: null,
      slug: null,
    } as const satisfies Parameters<typeof createCaseDecisionViewTab>[0];
    const requests: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const pathname = new URL(request.url).pathname;
        if (!pathname.endsWith(`/case/decisions/${documentId}`)) {
          throw new TypeError(`Unexpected decision transport: ${pathname}`);
        }
        requests.push(pathname);
        return Response.json(fullDecision);
      },
      { preconnect: () => undefined },
    );
    useExternalSourceStore.getState().registerSources([
      {
        title: target.caseNumber,
        url: publisher,
        appUrl: internal,
        sourceUrl: publisher,
        caseLawDecision: {
          decisionId: documentId,
          caseNumber: target.caseNumber,
        },
      },
    ]);
    const href =
      anchorId === null
        ? `#stella-decision=${documentId}`
        : `#stella-decision-passage=${documentId}:${anchorId}`;
    const view = await renderChat(
      <StreamdownMentionLink href={href} interactive>
        <BidiText as="span">{target.caseNumber}</BidiText>
      </StreamdownMentionLink>,
    );
    const primary = await view.findByRole("button", {
      name: decisionReference,
    });
    expect(primary.getAttribute("href")).toBe(
      new URL(
        createCaseLawDecisionPath(
          createCaseLawDecisionRouteParams({
            ...fullDecision,
            decisionId: fullDecision.id,
          }),
        ),
        env.VITE_PUBLIC_APP_URL,
      ).href,
    );
    expect(primary.textContent).toBe("NS");
    expect(primary.textContent).not.toContain(target.caseNumber);
    fireEvent.focus(primary);
    const source = await screen.findByRole("link", {
      name: messages.inspector.external.openOriginal,
    });
    expect(source.getAttribute("href")).toBe(publisher);
    const open = screen.getByRole("link", {
      name: messages.caseLaw.citation.openInStella,
    });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    open.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    await waitFor(() => {
      const decisions = useInspectorTabsStore.getState().tabs.flatMap((tab) =>
        tab.type === "view" && isCaseDecisionViewPayload(tab.payload)
          ? [
              {
                decisionId: tab.payload.decisionId,
                anchorId: tab.payload.anchorId,
              },
            ]
          : [],
      );
      expect(decisions).toEqual([
        { decisionId: documentId, anchorId: anchorId ?? undefined },
      ]);
    });
    expect(requests).toHaveLength(1);
  });
}

for (const interactive of [false, true]) {
  test(`a cached native decision keeps prose ${interactive ? "with a compact citation" : "in a passive answer"}`, async () => {
    const view = await renderChat(
      <StreamdownMentionLink
        href={`#stella-decision=${documentId}`}
        interactive={interactive}
      >
        <BidiText as="span">{quotedPassage}</BidiText>
      </StreamdownMentionLink>,
      fullDecision,
    );
    expect(view.getByText(quotedPassage)).toBeTruthy();
    if (!interactive) {
      expect(view.queryByRole("link")).toBeNull();
      return;
    }
    const primary = view.getByRole("button", { name: decisionReference });
    expect(primary.textContent).toBe("NS");
    expect(view.container.textContent).toBe(`${quotedPassage}NS`);
    fireEvent.focus(primary);
    const source = await screen.findByRole("link", {
      name: messages.inspector.external.openOriginal,
    });
    expect(source.getAttribute("href")).toBe(fullDecision.sourceUrl);
    expect(source.getAttribute("target")).toBe("_blank");
  });
}

test("a relative held primary keeps its publisher source in the tray and passive answer", async () => {
  const href = `${statutePath}#par-420`;
  const publisher = "https://publisher.example.test/relative-provision";
  const primaryUrl = new URL(href, env.VITE_PUBLIC_APP_URL).href;
  const label = "Relative provision";
  const view = await renderChat(
    <>
      <SourceChips
        activeOrganizationId="organization"
        messageId="relative"
        parts={[
          {
            type: "tool-call",
            name: "execute_typescript",
            id: "relative-source",
            state: "complete",
            arguments: "{}",
            output: {
              url: href,
              source_url: publisher,
              title: label,
            },
          },
        ]}
      />
      <StreamdownMentionLink href={href} interactive={false}>
        {label}
      </StreamdownMentionLink>
    </>,
  );
  await waitFor(() => {
    const primaryLinks = view.getAllByRole("link", {
      name: label,
    });
    expect(primaryLinks).toHaveLength(2);
    for (const primary of primaryLinks) {
      expect(primary.getAttribute("href")).toBe(primaryUrl);
    }
    const sources = view.getAllByRole("link", { name: messages.common.source });
    expect(sources).toHaveLength(2);
    for (const source of sources) {
      expect(source.getAttribute("href")).toBe(publisher);
    }
  });
});

test("a publisher alias with a canonical decision keeps the passage before the shared court chip", async () => {
  const publisher = "https://publisher.example.test/only-publisher";
  useExternalSourceStore.getState().registerSources([
    {
      title: fullDecision.caseNumber,
      url: publisher,
      caseLawDecision: {
        decisionId: documentId,
        caseNumber: fullDecision.caseNumber,
      },
    },
  ]);
  const view = await renderChat(
    <StreamdownMentionLink href={publisher} interactive>
      {quotedPassage}
    </StreamdownMentionLink>,
    fullDecision,
  );
  const primary = view.getByRole("button", { name: decisionReference });
  expect(primary.textContent).toBe("NS");
  expect(view.container.textContent).toBe(`${quotedPassage}NS`);
  fireEvent.focus(primary);
  const original = await screen.findByRole("link", {
    name: messages.inspector.external.openOriginal,
  });
  expect(original.getAttribute("href")).toBe(publisher);
  expect(
    screen
      .getByRole("link", {
        name: messages.caseLaw.citation.openInStella,
      })
      .getAttribute("href"),
  ).toBe(primary.getAttribute("href"));
});
