import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import { toChatDecisionPassageHref } from "@stll/api-contract";
import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import { toSafeId } from "@stll/api-contract/safe-id";

import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";
import { publicCaseLawCountryFromParam } from "@/features/case-law/case-law-jurisdiction";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import { unregisterDomEnvironment } from "@/test-dom-environment";

import { dockedChatLegalPayloads } from "../../../e2e/helpers/docked-chat-legal-payloads";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });
const { render, cleanup, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { WebReaderPresentationProvider } =
  await import("@/components/legal-reader/web-reader-presentation");
const { ChatThreadTestRouter } = await import("@/lib/chat-thread-test-router");
const { decisionOptions, decisionBySlugOptions } =
  await import("@/features/case-law/queries/decisions");
const {
  ChatAnswerDecisionProvider,
  ChatDecisionCitation,
  ChatRouteDecisionCitation,
} = await import("./chat-decision-citation");
const { useExternalSourceStore } = await import("./external-source-store");
const messages = (await import("@/i18n/langs/en.json")).default;

const first = {
  ...dockedChatLegalPayloads.decision,
  court: "Nejvyšší soud",
  courtAbbreviation: "NS",
  sourceUrl: "https://publisher.example.test/first",
} satisfies PublicCaseLawDecision;
const second = {
  ...first,
  id: toSafeId<"caseLawDecision">("019a0000-0000-7000-8000-000000000103"),
  caseNumber: "SYN 2/2026",
  slug: "synthetic-second-decision",
} satisfies PublicCaseLawDecision;
const clients: InstanceType<typeof QueryClient>[] = [];
const paragraph = "The court preserves the remedy.";
const href = (decisionId: string) =>
  toChatDecisionPassageHref({
    decisionId: toSafeId<"caseLawDecision">(decisionId),
    anchorId: "p-12",
    courtParagraphNumber: null,
  });
const answer = (markdown: string) =>
  ({
    id: "answer",
    role: "assistant",
    parts: [{ type: "text", content: markdown }],
  }) satisfies ChatUIMessage;
const mount = (client: InstanceType<typeof QueryClient>, children: ReactNode) =>
  render(
    <ChatThreadTestRouter>
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
            <WebReaderPresentationProvider>
              {children}
            </WebReaderPresentationProvider>
          </FormattingProvider>
        </IntlProvider>
      </QueryClientProvider>
    </ChatThreadTestRouter>,
  );
const clientWithDecisions = () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  clients.push(client);
  client.setQueryData(decisionOptions(first.id).queryKey, first);
  client.setQueryData(decisionOptions(second.id).queryKey, second);
  return client;
};

afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  useExternalSourceStore.setState({ sourcesByUrl: {} });
});
afterAll(async () => unregisterDomEnvironment());

test("two decisions from one court render each case number once as the accessible link trigger", async () => {
  const client = clientWithDecisions();
  const screen = mount(
    client,
    <ChatAnswerDecisionProvider
      message={answer(
        `[${first.caseNumber}](${href(first.id)}) [${second.caseNumber}](${href(second.id)})`,
      )}
      isAwaitingUser={false}
    >
      <p>
        <ChatDecisionCitation
          decisionId={first.id}
          passage={first.caseNumber}
          interactive
        />
        {" · "}
        <ChatDecisionCitation
          decisionId={second.id}
          passage={second.caseNumber}
          interactive
        />
      </p>
    </ChatAnswerDecisionProvider>,
  );
  await waitFor(() =>
    expect(
      screen.container.querySelectorAll(
        '[data-citation-presentation="inline"]',
      ),
    ).toHaveLength(2),
  );
  const rendered = screen.container.querySelector("p")?.textContent ?? "";
  expect(rendered.split(first.caseNumber)).toHaveLength(2);
  expect(rendered.split(second.caseNumber)).toHaveLength(2);
  for (const trigger of screen.container.querySelectorAll(
    "a[data-decision-citation]",
  )) {
    expect(trigger.getAttribute("aria-label")).toContain(
      trigger.textContent.replace("NS", ""),
    );
  }
});

const mountSingle = (caseNumber: string, passage: string) => {
  const decision = { ...first, caseNumber };
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  clients.push(client);
  client.setQueryData(decisionOptions(decision.id).queryKey, decision);
  return mount(
    client,
    <ChatDecisionCitation
      decisionId={decision.id}
      passage={passage}
      interactive
    />,
  );
};

test("different registry suffixes keep the prose and show the verified number beside it", async () => {
  const screen = mountSingle("23 Cdo 651/2023-7", "23 Cdo 651/2023-123");
  await waitFor(() =>
    expect(
      screen.container.querySelector("[data-decision-citation]")?.textContent,
    ).toContain("23 Cdo 651/2023-7"),
  );
  expect(screen.container.textContent).toContain("23 Cdo 651/2023-123");
  expect(screen.container.textContent).not.toContain("-7-123");
});

test("a link label that does not name the case still shows the verified identity", async () => {
  const screen = mountSingle("23 Cdo 651/2023", "Decision A");
  await waitFor(() =>
    expect(
      screen.container.querySelector("[data-decision-citation]")?.textContent,
    ).toContain("23 Cdo 651/2023"),
  );
  expect(screen.container.textContent).toContain("Decision A");
  expect(screen.container.textContent.split("23 Cdo 651/2023")).toHaveLength(2);
});

test("a real slug cache read contributes its resolved canonical decision to answer disambiguation", async () => {
  const client = clientWithDecisions();
  const params = createCaseLawDecisionRouteParams({
    ...second,
    decisionId: second.id,
  });
  const slugOptions = decisionBySlugOptions({
    country:
      publicCaseLawCountryFromParam(params.country) ??
      panic("Synthetic citation country must be public"),
    slug: params.slug,
  });
  client.setQueryData(slugOptions.queryKey, second);
  const path = createCaseLawDecisionPath(params);
  const screen = mount(
    client,
    <ChatAnswerDecisionProvider
      message={answer(`[First](${href(first.id)}) [Second](${path})`)}
      isAwaitingUser={false}
    >
      <p>
        <ChatDecisionCitation
          decisionId={first.id}
          passage={paragraph}
          interactive
        />
      </p>
      <p>
        <ChatRouteDecisionCitation
          params={params}
          passage={paragraph}
          interactive
        />
      </p>
    </ChatAnswerDecisionProvider>,
  );
  await waitFor(() =>
    expect(
      screen.container.querySelectorAll("[data-decision-citation]"),
    ).toHaveLength(2),
  );
  expect(
    screen.container.querySelector(`[data-decision-citation="${second.id}"]`),
  ).not.toBeNull();
  client.setQueryData(slugOptions.queryKey, {
    ...second,
    courtAbbreviation: "NSS",
  });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(
    screen.container.querySelector(`[data-decision-citation="${second.id}"]`)
      ?.textContent,
  ).toContain(second.caseNumber);
  expect(screen.container.textContent).toContain(paragraph);
  expect(client.isFetching()).toBe(0);
});

test("passive answer links and complete carried source metadata schedule no decision fetch", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const passive = mount(
    client,
    <ChatAnswerDecisionProvider
      message={answer(`[First](${href(first.id)})`)}
      isAwaitingUser={false}
    >
      <ChatDecisionCitation
        decisionId={first.id}
        passage={paragraph}
        interactive={false}
      />
    </ChatAnswerDecisionProvider>,
  );
  expect(passive.container.textContent).toBe(paragraph);
  expect(client.isFetching()).toBe(0);
  passive.unmount();
  const readerUrl = new URL(
    createCaseLawDecisionPath(
      createCaseLawDecisionRouteParams({ ...first, decisionId: first.id }),
    ),
    window.location.origin,
  ).href;
  useExternalSourceStore.getState().registerSources([
    {
      url: readerUrl,
      sourceUrl: first.sourceUrl,
      title: first.caseNumber,
      caseLawDecision: {
        decisionId: first.id,
        caseNumber: first.caseNumber,
        citation: {
          court: first.court,
          courtShortCode: "NS",
          decisionDate: first.decisionDate,
        },
      },
    },
  ]);
  const active = mount(
    client,
    <ChatAnswerDecisionProvider
      message={answer(`[First](${first.sourceUrl})`)}
      isAwaitingUser={false}
    >
      <ChatDecisionCitation
        decisionId={first.id}
        passage={paragraph}
        interactive
      />
    </ChatAnswerDecisionProvider>,
  );
  await waitFor(() =>
    expect(
      active.container.querySelector("[data-decision-citation]")?.textContent,
    ).toContain(first.caseNumber),
  );
  expect(active.container.textContent).toContain(paragraph);
  expect(client.isFetching()).toBe(0);
});

test("an anchored decision chip carries its paragraph in the link native navigation follows", async () => {
  const view = mount(
    clientWithDecisions(),
    <ChatDecisionCitation
      decisionId={first.id}
      passage={paragraph}
      paragraph={{ anchorId: "p-12", courtParagraphNumber: null }}
      interactive
    />,
  );
  const link = await waitFor(() => {
    const anchor = view.container.querySelector("a[href]");
    expect(anchor).not.toBeNull();
    return anchor ?? panic("chip link missing");
  });
  const target = new URL(
    link.getAttribute("href") ?? "",
    window.location.origin,
  );
  expect(target.hash).toBe("#p-12");
  expect(target.pathname).not.toContain("#");
});

test("the court's number the link carries shows at first paint, from a read or a carried source, never by fetching", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  // The decision itself is never read here: neither the cache nor a fetch
  // holds its document, so the number can only come from the link.
  client.setQueryData(decisionOptions(second.id).queryKey, second);
  const readerUrl = new URL(
    createCaseLawDecisionPath(
      createCaseLawDecisionRouteParams({ ...first, decisionId: first.id }),
    ),
    window.location.origin,
  ).href;
  useExternalSourceStore.getState().registerSources([
    {
      url: readerUrl,
      sourceUrl: first.sourceUrl,
      title: first.caseNumber,
      caseLawDecision: {
        decisionId: first.id,
        caseNumber: first.caseNumber,
        citation: {
          court: first.court,
          courtShortCode: "NS",
          decisionDate: first.decisionDate,
        },
      },
    },
  ]);
  const view = mount(
    client,
    <ChatAnswerDecisionProvider
      message={answer(`[First](${first.sourceUrl})`)}
      isAwaitingUser={false}
    >
      <p>
        <ChatDecisionCitation
          decisionId={first.id}
          passage={paragraph}
          paragraph={{ anchorId: "p-12", courtParagraphNumber: 8 }}
          interactive
        />
      </p>
      <p>
        <ChatDecisionCitation
          decisionId={second.id}
          passage={paragraph}
          paragraph={{ anchorId: "p-14", courtParagraphNumber: 9 }}
          interactive
        />
      </p>
      <p>
        <ChatDecisionCitation
          decisionId={second.id}
          passage={paragraph}
          paragraph={{ anchorId: "h-1", courtParagraphNumber: null }}
          interactive
        />
      </p>
    </ChatAnswerDecisionProvider>,
  );
  const chips = view.container.querySelectorAll("[data-decision-citation]");
  expect(chips).toHaveLength(3);
  const [carried, read, unnumbered] = chips;
  expect(carried?.textContent).toEndWith("¶ 8");
  expect(carried?.textContent).not.toContain(paragraph);
  expect(view.container.textContent).toContain(paragraph);
  expect(carried?.getAttribute("aria-label")).toEndWith(", paragraph 8");
  expect(read?.textContent).toEndWith("¶ 9");
  expect(unnumbered?.textContent).not.toContain("¶");
  expect(unnumbered?.getAttribute("aria-label")).not.toContain("paragraph");
  expect(client.isFetching()).toBe(0);
});
