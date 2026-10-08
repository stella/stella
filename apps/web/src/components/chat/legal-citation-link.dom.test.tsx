import type { ReactElement } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

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
const { cleanup, render, waitFor } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
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
afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  useExternalSourceStore.setState({ sourcesByUrl: {} });
  useInspectorTabsStore.setState({ tabs: [], activeId: null });
  globalThis.fetch = idleFetch;
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (originalPublicLawFlag === undefined) {
    delete process.env["VITE_PUBLIC_LAW_ENABLED"];
  } else {
    process.env["VITE_PUBLIC_LAW_ENABLED"] = originalPublicLawFlag;
  }
  await GlobalRegistrator.unregister();
});

const renderChat = async (children: ReactElement) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
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
        <router.RouterProvider router={appRouter} />
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
const citations = [
  { kind: "statute", path: statutePath },
  { kind: "provision", path: `${statutePath}#par-420` },
  { kind: "decision", path: decisionPath },
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
        return Response.json({
          ...target,
          id: target.decisionId,
          documentAst: null,
          resolution: { type: "direct" },
        });
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
    const primary = view.getByRole("link", { name: target.caseNumber });
    expect(primary.getAttribute("href")).toBe(
      anchorId === null ? internal : `${internal}#${anchorId}`,
    );
    expect(
      view
        .getByRole("link", { name: messages.common.source })
        .getAttribute("href"),
    ).toBe(publisher);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    primary.dispatchEvent(click);
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
  test(`a native decision without a reader URL uses its publisher in ${interactive ? "interactive" : "passive"} answers`, async () => {
    const publisher = "https://publisher.example.test/unheld-decision";
    const caseNumber = "26 Cdo 4249/2016";
    useExternalSourceStore.getState().registerSources([
      {
        title: caseNumber,
        url: publisher,
        sourceUrl: publisher,
        caseLawDecision: { decisionId: documentId, caseNumber },
      },
    ]);
    const view = await renderChat(
      <StreamdownMentionLink
        href={`#stella-decision=${documentId}`}
        interactive={interactive}
      >
        <BidiText as="span">{caseNumber}</BidiText>
      </StreamdownMentionLink>,
    );
    const primary = view.getByRole("link", { name: caseNumber });
    expect(primary.getAttribute("href")).toBe(publisher);
    expect(primary.getAttribute("target")).toBe("_blank");
    expect(primary.getAttribute("rel")).toContain("noopener");
    expect(
      view.queryByRole("link", { name: messages.common.source }),
    ).toBeNull();
    expect(view.getAllByRole("link")).toHaveLength(1);
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
