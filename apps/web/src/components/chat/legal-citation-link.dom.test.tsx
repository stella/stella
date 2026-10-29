import type { ReactElement } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { AskUserInput } from "@/components/chat/chat-ui-tools";
import type { DecisionTabTarget } from "@/features/case-law/decision-inspector.logic";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import type { api } from "@/lib/api";
import type { PublicLawData } from "@/lib/public-law-api";
import { unregisterDomEnvironment } from "@/test-dom-environment";

import type { CaseLawDecisionLocator } from "./case-law-open";

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
const { WebReaderPresentationProvider } =
  await import("@/components/legal-reader/web-reader-presentation");
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
const { SourceChips } = await import("@/features/chat/source-chips");
const { StreamdownMentionLink } = await import("./streamdown-mention-link");
const { LegalCitationLink } = await import("./legal-citation-link");
const { DecisionMainViewAction } =
  await import("@/features/case-law/components/decision-main-view-action");
const { registerMainDecisionReader, mainDecisionReaderStore } =
  await import("@/components/inspector/main-decision-reader");
const { openCaseLawDecision } = await import("./case-law-open");
const { messageComponents } =
  await import("@/components/ai-elements/message-response-components");
const { AskUserCard } = await import("./ask-user-card");
const arabicMessages = (await import("@/i18n/langs/ar.json")).default;
const { MessageResponseImpl } =
  await import("@/components/ai-elements/message-response");
const { useExternalSourceStore } = await import("./external-source-store");
const { useInspectorTabsStore } =
  await import("@/components/inspector/inspector-tabs-store");

const { createCaseDecisionViewTab, isCaseDecisionViewPayload } =
  await import("@/components/inspector/case-decision-view");

const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(async () => {
  await act(async () => {
    cleanup();
    await Promise.all(clients.map(async (client) => client.cancelQueries()));
    for (const client of clients) {
      client.clear();
    }
    clients.length = 0;
    useExternalSourceStore.setState({ sourcesByUrl: {} });
    useInspectorTabsStore.setState({ tabs: [], activeId: null });
    mainDecisionReaderStore.setState({ reader: null });
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
  await unregisterDomEnvironment();
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
          <WebReaderPresentationProvider>
            <router.RouterProvider router={appRouter} />
          </WebReaderPresentationProvider>
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
  citationCount: 0,
  id: toSafeId<"caseLawDecision">(documentId),
  caseNumber: "26 Cdo 4249/2016",
  caseNumberType: "case-number",
  country: "CZE",
  court: "Nejvyšší soud",
  courtId: null,
  courtAbbreviation: "NS",
  courtTier: "supreme",
  decisionDate: "2017-01-12",
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

const canonicalDecision = {
  ...fullDecision,
  ecli: "ECLI:CZ:NS:2017:26.CDO.4249.2016.1",
  slug: "26-cdo-4249-2016",
} satisfies PublicCaseLawDecision;
const canonicalSearchHit = {
  ...canonicalDecision,
  decisionId: documentId,
  identifiers: [{ type: "case-number", value: canonicalDecision.caseNumber }],
  textWithheldReason: null,
  keywords: null,
  anchorId: null,
  headline: null,
  citationAuthority: 0,
  citationCount: 0,
  textAvailability: "available",
  matchingPassages: 1,
  match: "all_terms",
} satisfies PublicLawData<
  typeof api.case.decisions.search.post
>["hits"][number];
const routeParams = createCaseLawDecisionRouteParams({
  ...canonicalDecision,
  decisionId: documentId,
});
const idRouteParams = createCaseLawDecisionRouteParams({
  ...canonicalDecision,
  decisionId: documentId,
  slug: null,
});
const decisionLocators = [
  { name: "decision id", locator: { type: "ref", ref: documentId } },
  {
    name: "ECLI",
    locator: { type: "ref", ref: canonicalDecision.ecli },
  },
  {
    name: "file number",
    locator: { type: "ref", ref: canonicalDecision.caseNumber },
  },
  {
    name: "encoded file number",
    locator: {
      type: "ref",
      ref: encodeURIComponent(canonicalDecision.caseNumber),
    },
  },
  { name: "slug route", locator: { type: "route", params: routeParams } },
  { name: "id route", locator: { type: "route", params: idRouteParams } },
  {
    name: "language route",
    locator: { type: "route", params: { ...routeParams, language: "cs" } },
  },
  {
    name: "language id route",
    locator: { type: "route", params: { ...idRouteParams, language: "cs" } },
  },
] as const satisfies readonly {
  name: string;
  locator: CaseLawDecisionLocator;
}[];

for (const { name, locator } of decisionLocators) {
  for (const anchorId of [undefined, "p-12"]) {
    test(`a ${name} resolves to the same canonical decision ${anchorId === undefined ? "without a passage" : "at its cited passage"}`, async () => {
      const requests: Request[] = [];
      globalThis.fetch = Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          requests.push(request);
          if (url.pathname.endsWith("/case/decisions/search")) {
            return Response.json({
              hits: [
                {
                  ...canonicalSearchHit,
                  decisionId: "019dd47e-2d83-7178-8f24-11f2976a01db",
                  caseNumber: "26 Cdo 999/2016",
                  ecli: "ECLI:CZ:NS:2017:26.CDO.999.2016.1",
                },
                canonicalSearchHit,
              ],
            });
          }
          if (
            url.pathname.endsWith(`/case/decisions/${documentId}`) ||
            url.pathname.endsWith(
              `/case/decisions/by-slug/${canonicalDecision.slug}`,
            )
          ) {
            return Response.json(canonicalDecision);
          }
          throw new TypeError(`Unexpected decision transport: ${url.pathname}`);
        },
        { preconnect: () => undefined },
      );
      const opened: DecisionTabTarget[] = [];
      await openCaseLawDecision(
        locator,
        (target) => {
          opened.push(target);
        },
        { anchorId },
      );
      expect(opened).toEqual([
        {
          decisionId: documentId,
          caseNumber: canonicalDecision.caseNumber,
          court: canonicalDecision.court,
          country: canonicalDecision.country,
          language: canonicalDecision.language,
          languageAlternates: canonicalDecision.languageAlternates,
          slug: canonicalDecision.slug,
          ...(anchorId !== undefined && { anchorId }),
        },
      ]);
      expect(requests).toHaveLength(1);
      const request = requests.at(0);
      expect(request).toBeDefined();
      if (locator.type === "ref" && locator.ref !== documentId) {
        expect(await request?.json()).toMatchObject({
          query: decodeURIComponent(locator.ref),
          limit: 5,
        });
      }
      if (name === "language route") {
        expect(new URL(request?.url ?? "").searchParams.get("language")).toBe(
          "cs",
        );
      }
    });
  }
}

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
                      url: held ? internal : null,
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
            // One chip per citation: a held primary trails no publisher link
            // and carries no glyph beside its own text.
            expect(surface.querySelectorAll("a")).toHaveLength(1);
            if (held) {
              expect(surface.querySelector("svg")).toBeNull();
            }
          }
        });
        const trayPrimary = sources.querySelector("a");
        expect(trayPrimary?.classList.contains("border")).toBe(true);
        expect(trayPrimary?.classList.contains("bg-muted/50")).toBe(true);
        const trayLabel = trayPrimary?.querySelector(".truncate");
        expect(trayLabel?.classList.contains("max-w-[20ch]")).toBe(true);
        expect(trayLabel?.classList.contains("truncate")).toBe(true);
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
                url: internal,
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
    // The tray lists the source by its court; in the answer the quotation
    // stays as text and the chip after it shows the verified number too.
    for (const [surface, label] of [
      [sources, "NS"],
      [answer, `NS${fullDecision.caseNumber}`],
    ] as const) {
      const chip = surface.querySelector("[data-decision-citation]");
      expect(chip?.textContent).toBe(label);
      expect(chip?.getAttribute("aria-label")).toBe(decisionReference);
      expect(chip?.textContent).not.toContain(quotedPassage);
    }
  });
  expect(answer.textContent).toBe(
    `${quotedPassage} NS${fullDecision.caseNumber}`,
  );
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
      url: internal,
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
      view.queryAllByRole("link", { name: messages.common.source }),
    ).toHaveLength(0);
  });
});

test("Arabic clarification questions use automatic direction and localized numbering", async () => {
  const input = {
    analysis: "Review [the source](https://example.test/source).",
    questions: [
      {
        question: "هل ينبغي متابعة هذا المصدر؟",
        reason: "يحدد الجواب الخطوة التالية.",
      },
    ],
  } satisfies AskUserInput;
  const view = await renderChat(
    <IntlProvider locale="ar" messages={arabicMessages} timeZone="UTC">
      <FormattingProvider locale="ar-u-nu-arab" timeZone="UTC">
        <WebReaderPresentationProvider>
          <AskUserCard
            isAwaitingUser
            onSubmit={() => undefined}
            part={{
              type: "tool-call",
              name: "ask-user",
              id: "arabic-ask",
              state: "input-complete",
              arguments: JSON.stringify(input),
              input,
            }}
          />
        </WebReaderPresentationProvider>
      </FormattingProvider>
    </IntlProvider>,
  );
  const questions = view.container.querySelector("form")?.querySelector("ol");
  const question = view.container.querySelector("form p");
  expect(questions?.getAttribute("lang")).toBe("ar-u-nu-arab");
  expect(questions?.style.listStyleType).toBe("arabic-indic");
  expect(question?.getAttribute("dir")).toBe("auto");
  expect(question?.textContent).toBe("هل ينبغي متابعة هذا المصدر؟");
});

test("an external primary opens immediately in a new tab without inspector interception", async () => {
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
  expect(click.defaultPrevented).toBe(false);
  expect(primary.getAttribute("href")).toBe(publisher);
  expect(primary.getAttribute("target")).toBe("_blank");
  expect(primary.getAttribute("rel")).toBe("noopener noreferrer");
  expect(primary.firstElementChild?.querySelector("svg")).not.toBeNull();
  expect(primary.querySelector("bdi")?.textContent).toBe(label);
  primary.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  primary.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
  expect(view.container.querySelector("img")).toBeNull();
  expect(useInspectorTabsStore.getState().tabs).toHaveLength(0);
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
        url: internal,
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
    const primary = await view.findByRole("link", {
      name: decisionReference,
    });
    const reader = new URL(
      createCaseLawDecisionPath(
        createCaseLawDecisionRouteParams({
          ...fullDecision,
          decisionId: fullDecision.id,
        }),
      ),
      env.VITE_PUBLIC_APP_URL,
    );
    // Native navigation follows the href, so a cited passage rides in it.
    reader.hash = anchorId ?? "";
    expect(primary.getAttribute("href")).toBe(
      `${reader.pathname}${reader.search}${reader.hash}`,
    );
    expect(primary.textContent).toBe(`NS${target.caseNumber}`);
    fireEvent.focus(primary);
    const source = await screen.findByRole("link", {
      name: messages.inspector.external.openOriginal,
    });
    expect(source.getAttribute("href")).toBe(publisher);
    expect(
      screen
        .getByRole("link", { name: messages.common.openInStella })
        .getAttribute("href"),
    ).toBe(primary.getAttribute("href"));
    fireEvent.click(
      screen.getByRole("button", { name: messages.common.openInSidePanel }),
    );
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
    const primary = view.getByRole("link", { name: decisionReference });
    expect(primary.textContent).toBe(`NS${fullDecision.caseNumber}`);
    expect(view.container.textContent).toBe(
      `${quotedPassage} NS${fullDecision.caseNumber}`,
    );
    fireEvent.focus(primary);
    const source = await screen.findByRole("link", {
      name: messages.inspector.external.openOriginal,
    });
    expect(source.getAttribute("href")).toBe(fullDecision.sourceUrl);
    expect(source.getAttribute("target")).toBe("_blank");
  });
}

test("a long external source title stays inside its truncated tray chip", async () => {
  const title = "Publisher".repeat(12);
  const href = "https://publisher.example.test/long-title";
  const view = await renderChat(
    <SourceChips
      messageId="long-external"
      parts={[
        {
          type: "tool-call",
          name: "execute_typescript",
          id: "long-external-source",
          state: "complete",
          arguments: "{}",
          output: { url: href, title },
        },
      ]}
    />,
  );
  await waitFor(() => {
    const chip = view.getByRole("link", { name: title });
    expect(chip.getAttribute("href")).toBe(href);
    expect(chip.getAttribute("target")).toBe("_blank");
    expect(chip.getAttribute("rel")).toBe("noopener noreferrer");
    expect(chip.className).toContain("rounded-md");
    expect(chip.className).toContain("border");
    const label = chip.querySelector(".truncate");
    expect(label?.className).toContain("max-w-[20ch]");
    expect(label?.textContent).toBe(title);
  });
});

test("a relative held primary is one chip in the tray and the passive answer", async () => {
  const href = `${statutePath}#par-420`;
  const publisher = "https://publisher.example.test/relative-provision";
  const primaryUrl = new URL(href, env.VITE_PUBLIC_APP_URL).href;
  const label = "Relative provision";
  const view = await renderChat(
    <>
      <SourceChips
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
    expect(
      view.queryAllByRole("link", { name: messages.common.source }),
    ).toHaveLength(0);
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
  const primary = view.getByRole("link", { name: decisionReference });
  expect(primary.textContent).toBe(`NS${fullDecision.caseNumber}`);
  expect(view.container.textContent).toBe(
    `${quotedPassage} NS${fullDecision.caseNumber}`,
  );
  fireEvent.focus(primary);
  const original = await screen.findByRole("link", {
    name: messages.inspector.external.openOriginal,
  });
  expect(original.getAttribute("href")).toBe(publisher);
  expect(
    screen
      .getByRole("link", {
        name: messages.common.openInStella,
      })
      .getAttribute("href"),
  ).toBe(primary.getAttribute("href"));
});

for (const explicitAnchorId of [undefined, "p-30"]) {
  test(`a publisher alias opens its decision at the ${explicitAnchorId === undefined ? "anchor stored in its reader URL" : "explicit anchor over the stored one"}`, async () => {
    const publisher = "https://publisher.example.test/stored-anchor";
    const internal = new URL(`${decisionPath}#p-12`, window.location.origin)
      .href;
    const view = await renderChat(
      <LegalCitationLink
        source={{
          title: fullDecision.caseNumber,
          url: internal,
          sourceUrl: publisher,
        }}
        anchorId={explicitAnchorId}
        interactive
        appearance="inline"
        linkIconSource={{ kind: "tool-source" }}
      >
        {quotedPassage}
      </LegalCitationLink>,
      fullDecision,
    );
    const primary = await view.findByRole("link", {
      name: decisionReference,
    });
    fireEvent.focus(primary);
    fireEvent.click(
      await screen.findByRole("button", {
        name: messages.common.openInSidePanel,
      }),
    );
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
        { decisionId: documentId, anchorId: explicitAnchorId ?? "p-12" },
      ]);
    });
  });
}

test("reply markdown and clarification analysis share bare-domain chips without remote icons", async () => {
  const input = {
    analysis:
      "Read stll.app and [Repository](https://github.com/stella/stella).",
    questions: [{ question: "Continue?", reason: "Confirm the reading." }],
  };
  const view = await renderChat(
    <>
      <MessageResponseImpl>{input.analysis}</MessageResponseImpl>
      <AskUserCard
        isAwaitingUser
        onSubmit={() => undefined}
        part={{
          type: "tool-call",
          name: "ask-user",
          id: "external-links",
          state: "input-complete",
          arguments: JSON.stringify(input),
          input,
        }}
      />
    </>,
  );
  await waitFor(() => {
    for (const name of ["stll.app", "Repository"]) {
      const links = view.getAllByRole("link", { name });
      expect(links).toHaveLength(2);
      for (const link of links) {
        expect(link.getAttribute("target")).toBe("_blank");
        expect(link.getAttribute("rel")).toBe("noopener noreferrer");
        expect(link.firstElementChild?.querySelector("svg")).not.toBeNull();
        expect(link.children.item(1)?.tagName).toBe("BDI");
        fireEvent.mouseEnter(link);
        fireEvent.focus(link);
      }
    }
  });
  expect(view.container.querySelector("img")).toBeNull();
});

test("relative Markdown destinations retain their original href through citation classification", async () => {
  const label = "Relative source";
  const href = "/github.com/stella";
  const view = await renderChat(
    <StreamdownMentionLink href={href} interactive>
      {label}
    </StreamdownMentionLink>,
  );
  const link = view.getByRole("link", { name: label });
  expect(link.getAttribute("href")).toBe(href);
  expect(
    new URL(link.getAttribute("href") ?? "", window.location.href).origin,
  ).toBe(window.location.origin);
  expect(link.querySelector("svg")).toBeNull();
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  expect(link.getAttribute("target")).toBe("_blank");
});

test("maximizing a different decision docks the displaced main reader before navigation", async () => {
  const side = createCaseDecisionViewTab({
    decisionId: "019dd47d-f507-7c84-b827-980af11b8981",
    caseNumber: "SYN 2/2026",
    country: "CZE",
    court: "Synthetic Court",
    language: null,
    languageAlternates: null,
    slug: "other-decision",
  });
  const store = useInspectorTabsStore.getState();
  store.openView(side);
  const openedPassages: string[] = [];
  registerMainDecisionReader({
    decisionId: fullDecision.id,
    openPassage: ({ decisionId }) => {
      openedPassages.push(decisionId);
    },
  });
  const root = router.createRootRoute({ component: router.Outlet });
  const decisionRoute = router.createRoute({
    getParentRoute: () => root,
    path: "/law/$country/cases/$court/$slug",
    loader: () => fullDecision,
    component: () => (
      <DecisionMainViewAction
        payload={side.payload}
        onMoveToMain={() => store.closeTab(side.id)}
      />
    ),
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({
      initialEntries: ["/law/cze/cases/synthetic-court/main-decision"],
    }),
    routeTree: root.addChildren([decisionRoute]),
    isServer: false,
  });
  await appRouter.load();
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <WebReaderPresentationProvider>
          <router.RouterProvider router={appRouter} />
        </WebReaderPresentationProvider>
      </FormattingProvider>
    </IntlProvider>,
  );
  fireEvent.click(
    screen.getByRole("link", { name: messages.inspector.swapViews }),
  );
  await waitFor(() =>
    expect(appRouter.state.location.pathname).toEndWith("/other-decision"),
  );
  expect(openedPassages).toEqual([]);
  expect(useInspectorTabsStore.getState().tabs).toHaveLength(1);
  expect(useInspectorTabsStore.getState().tabs.at(0)).toMatchObject({
    payload: { decisionId: fullDecision.id },
  });
});

test("an external tray label without a safe URL retains its compact presentation", async () => {
  const title = "Unavailable publisher title".repeat(8);
  const view = await renderChat(
    <LegalCitationLink
      appearance="tray"
      interactive={false}
      linkIconSource={{ kind: "tool-source" }}
      source={{ title, url: "data:text/plain,unavailable" }}
    >
      {title}
    </LegalCitationLink>,
  );
  const label = view.getByText(title);
  expect(label.className).toContain("max-w-[20ch]");
  expect(label.className).toContain("truncate");
  expect(label.parentElement?.className).toContain("border");
  expect(view.queryByRole("link")).toBeNull();
});
