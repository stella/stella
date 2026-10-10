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
            {children}
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

test("same-decision repetitions stay compact while two actually cited decisions sharing a court expand", async () => {
  const client = clientWithDecisions();
  const renderAnswer = (markdown: string) => (
    <ChatAnswerDecisionProvider
      message={answer(markdown)}
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
        <ChatDecisionCitation
          decisionId={first.id}
          passage={paragraph}
          interactive
        />
      </p>
      <p>
        <ChatDecisionCitation
          decisionId={second.id}
          passage={paragraph}
          interactive
        />
      </p>
    </ChatAnswerDecisionProvider>
  );
  const screen = mount(
    client,
    renderAnswer(`[First](${href(first.id)}) [repeat](${href(first.id)})`),
  );
  await waitFor(() =>
    expect(
      screen.container.querySelectorAll(
        '[data-citation-presentation="compact"]',
      ),
    ).toHaveLength(3),
  );
  expect(
    screen.container.querySelector("[data-decision-citation]")?.textContent,
  ).toBe("NS");
  screen.rerender(
    <ChatThreadTestRouter>
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
            {renderAnswer(
              `[First](${href(first.id)}) [Second](${href(second.id)})`,
            )}
          </FormattingProvider>
        </IntlProvider>
      </QueryClientProvider>
    </ChatThreadTestRouter>,
  );
  await waitFor(() =>
    expect(
      screen.container.querySelectorAll(
        '[data-citation-presentation="expanded"]',
      ),
    ).toHaveLength(3),
  );
  expect(
    screen.container.querySelector("[data-decision-citation]")?.textContent,
  ).not.toContain(paragraph);
  expect(screen.container.querySelector("p")?.firstChild?.textContent).toBe(
    paragraph,
  );
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
      screen.container.querySelectorAll(
        '[data-citation-presentation="expanded"]',
      ),
    ).toHaveLength(2),
  );
  expect(
    screen.container.querySelector(`[data-decision-citation="${second.id}"]`),
  ).not.toBeNull();
  client.setQueryData(slugOptions.queryKey, {
    ...second,
    courtAbbreviation: "NSS",
  });
  await waitFor(() =>
    expect(
      screen.container.querySelectorAll(
        '[data-citation-presentation="compact"]',
      ),
    ).toHaveLength(2),
  );
  expect(
    screen.container.querySelector(`[data-decision-citation="${second.id}"]`)
      ?.textContent,
  ).toBe("NSS");
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
      url: first.sourceUrl,
      appUrl: readerUrl,
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
    ).toBe("NS"),
  );
  expect(client.isFetching()).toBe(0);
});

test("an anchored decision chip carries its paragraph in the link native navigation follows", async () => {
  const view = mount(
    clientWithDecisions(),
    <ChatDecisionCitation
      decisionId={first.id}
      passage={paragraph}
      anchorId="p-12"
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
