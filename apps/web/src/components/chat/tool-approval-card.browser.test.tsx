import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import {
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_CONTROL_TARGET_METADATA,
  BROWSER_CONTROL_TOOL_NAME,
} from "@stll/api-contract/browser-control";
import { USE_CONNECTOR_SECRET_TOOL_NAME } from "@stll/api-contract/chat-secret";

import { ChatApprovalContext } from "@/components/chat/chat-approval-context";
import {
  getToolApprovalGrant,
  isApprovalPart,
} from "@/components/chat/chat-ui-tools";
import type { ToolApprovalGrant } from "@/components/chat/chat-ui-tools";
import { ToolApprovalCard } from "@/components/chat/tool-approval-card";
import { observeBrowserPage } from "@/features/chat/browser-control/browser-approval-mode";
import { browserSiteGrantsOptions } from "@/features/chat/browser-control/browser-site-grants";
import messages from "@/i18n/langs/en.json";
import {
  type AuthenticatedUser,
  AuthenticatedUserProvider,
} from "@/lib/authenticated-user-context";
import { toSafeId } from "@/lib/safe-id";

const noop = () => undefined;

type RenderOptions = {
  queryClient?: QueryClient;
  user?: AuthenticatedUser | null;
};

const member: AuthenticatedUser = {
  activeOrganizationId: "org-1",
  email: "member@example.test",
  id: "user-1",
  image: null,
  name: "Member",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};

/** A query cache holding the member's website approvals. */
const withAllowedSites = (origins: readonly string[]) => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    browserSiteGrantsOptions({
      activeOrganizationId: member.activeOrganizationId,
      userId: member.id,
    }).queryKey,
    {
      grants: origins.map((origin, index) => ({
        id: toSafeId<"chatBrowserSiteGrant">(
          `00000000-0000-4000-8000-00000000000${index}`,
        ),
        origin,
      })),
    },
  );
  return queryClient;
};

const renderCard = (
  part: unknown,
  grants: ReadonlySet<ToolApprovalGrant> = new Set(),
  { queryClient = new QueryClient(), user = null }: RenderOptions = {},
) => {
  if (!isApprovalPart(part)) {
    throw new Error("Expected a browser approval part");
  }
  const card = (
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <ChatApprovalContext
        value={{
          activeOrganizationId: "org-1",
          alwaysApprovedTools: grants,
          conversationApprovedTools: grants,
          confirmStoredApprovalGrant: async () =>
            await Promise.resolve(grants.size > 0),
          handleAllowInConversation: noop,
          handleAlwaysAllow: noop,
          handleApprove: noop,
          handleDeny: noop,
          continueRequestSecret: async () => {},
          continueConnectConnector: async () => {},
          handleConnectConnector: async () => ({
            status: "declined",
            connectorSlug: "test",
          }),
          handleRequestSecret: async () => ({
            status: "declined",
            target: { type: "mcp-connector", connectorSlug: "test" },
          }),
          secretAvailabilityKey: "test-thread",
          resolveSecretTarget: async () => ({
            available: false,
            connector: {
              connectionId: "sample-connection",
              displayName: "Sample connector",
              host: "sample.test",
              responseDisposition: "normal",
            },
          }),
        }}
      >
        <ToolApprovalCard isAwaitingUser isTurnActive={false} part={part} />
      </ChatApprovalContext>
    </IntlProvider>
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      {user === null ? (
        card
      ) : (
        <AuthenticatedUserProvider user={user}>
          {card}
        </AuthenticatedUserProvider>
      )}
    </QueryClientProvider>,
  );
};

const browserPart = (input: unknown, state: string, output?: unknown) => ({
  approval: { id: "approval-1", needsApproval: true },
  arguments: JSON.stringify(input),
  id: "tool-call-1",
  input,
  name: BROWSER_CONTROL_TOOL_NAME,
  state,
  type: "tool-call",
  ...(output === undefined ? {} : { output }),
});

const readPage = { action: "snapshot" };
const browserQuestion = messages.chat.approval.browser.question;
const secretUseInput = {
  secretRef: "00000000-0000-4000-8000-000000000001",
  target: { type: "mcp-connector", connectorSlug: "sample-connector" },
  toolName: "list_records",
  arguments: {},
};
const secretUsePart = () => ({
  approval: { id: "approval-secret-use", needsApproval: true },
  arguments: JSON.stringify(secretUseInput),
  id: "tool-call-secret-use",
  input: secretUseInput,
  name: USE_CONNECTOR_SECRET_TOOL_NAME,
  state: "approval-requested",
  type: "tool-call",
});

describe("browser approval card", () => {
  test("asks about a pending browser action", () => {
    expect(renderCard(browserPart(readPage, "approval-requested"))).toContain(
      browserQuestion,
    );
  });

  test("says the website receives the real values it shows", () => {
    const fillForm = {
      action: "fill",
      page: { revision: "revision-1", url: "https://example.com/form" },
      target: {
        context: { type: BROWSER_CONTROL_TARGET_METADATA.absent },
        href: { type: BROWSER_CONTROL_TARGET_METADATA.absent },
        name: "Signatory",
        ref: "e:0:1",
        role: "textbox",
      },
      value: "Dana Novotná",
    };
    const realValues = messages.chat.approval.browser.realValues;

    const pending = renderCard(browserPart(fillForm, "approval-requested"));
    expect(pending).toContain(realValues);
    expect(pending).toContain("Dana Novotná");
    // A decided card no longer asks, so it no longer warns.
    expect(renderCard(browserPart(fillForm, "complete"))).not.toContain(
      realValues,
    );
  });

  test("a past browser action no longer asks", () => {
    const markup = renderCard(
      browserPart(readPage, "complete", {
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        snapshot: {
          contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
          elements: [],
          elementsLeftOut: false,
          facts: { meta: [] },
          revision: "revision-1",
          tabId: 7,
          tabs: [
            {
              active: true,
              tabId: 7,
              url: "https://example.com/",
            },
          ],
          text: "Ready",
          title: "Example",
          url: "https://example.com/",
          window: { cursor: "r1.window", fromPercent: 0, toPercent: 100 },
        },
        status: "success",
      }),
    );

    expect(markup).toContain(messages.chat.approval.browser.actions.snapshot);
    expect(markup).not.toContain(browserQuestion);
  });

  test("names a new tab and a tab switch with the website they lead to", () => {
    const { actions } = messages.chat.approval.browser;
    const newTab = renderCard(
      browserPart(
        { action: "open", newTab: true, url: "https://example.com/news" },
        "approval-requested",
      ),
    );
    expect(newTab).toContain(actions.openNewTab);
    expect(newTab).toContain("https://example.com/news");

    const switchTab = renderCard(
      browserPart(
        {
          action: "switch-tab",
          tabId: 9,
          url: "https://example.com/results",
        },
        "approval-requested",
      ),
    );
    expect(switchTab).toContain(actions.switchTab);
    expect(switchTab).toContain("https://example.com/results");
    expect(switchTab).toContain(browserQuestion);
  });

  test("a malformed browser command still shows what the model sent", () => {
    const markup = renderCard(
      browserPart(
        {
          action: "click",
          target: { name: "Pay now", ref: "not-a-ref", role: "button" },
        },
        "approval-requested",
      ),
    );

    expect(markup).toContain("not-a-ref");
    expect(markup).not.toContain(browserQuestion);
  });

  test("requires fresh approval for each private connector operation", () => {
    const grant = getToolApprovalGrant(USE_CONNECTOR_SECRET_TOOL_NAME);
    const markup = renderCard(secretUsePart(), new Set([grant]));

    expect(markup).toContain(messages.chat.approval.allowOnce);
    expect(markup).not.toContain(messages.chat.approval.allowInConversation);
    expect(markup).not.toContain(messages.chat.approval.alwaysAllow);
  });

  test("shows every private connector argument without truncation", () => {
    const benignPrefix = "x".repeat(240);
    const part = secretUsePart();
    const input = {
      ...secretUseInput,
      arguments: {
        benignPrefix,
        destructive_action: "delete_record",
      },
    };
    const markup = renderCard({
      ...part,
      arguments: JSON.stringify(input),
      input,
    });

    expect(markup).toContain(benignPrefix);
    expect(markup).toContain("destructive_action");
    expect(markup).toContain("delete_record");
  });
});

describe("always allowing a website", () => {
  const alwaysAllowSite = messages.chat.approval.browser.alwaysAllowSite;
  const openNews = { action: "open", url: "https://example.com/news" };

  test("a card for an action on a website offers to always allow it", () => {
    const markup = renderCard(
      browserPart(openNews, "approval-requested"),
      undefined,
      {
        user: member,
      },
    );
    expect(markup).toContain(messages.chat.approval.allowOnce);
    expect(markup).toContain(alwaysAllowSite);
    // The site the button covers stays on the card.
    expect(markup).toContain("https://example.com/news");
  });

  test("a website already allowed is not offered again", () => {
    const markup = renderCard(
      browserPart(openNews, "approval-requested"),
      undefined,
      {
        queryClient: withAllowedSites(["https://example.com"]),
        user: member,
      },
    );
    expect(markup).not.toContain(alwaysAllowSite);
  });

  test("another subdomain or port of an allowed website is still offered", () => {
    for (const url of [
      "https://www.example.com/",
      "https://example.com:8443/",
    ]) {
      const markup = renderCard(
        browserPart({ action: "open", url }, "approval-requested"),
        undefined,
        {
          queryClient: withAllowedSites(["https://example.com"]),
          user: member,
        },
      );
      expect(markup).toContain(alwaysAllowSite);
    }
  });

  test("a website that is not HTTPS cannot be always allowed", () => {
    const markup = renderCard(
      browserPart(
        { action: "open", url: "http://example.com/" },
        "approval-requested",
      ),
      undefined,
      { user: member },
    );
    expect(markup).toContain(messages.chat.approval.allowOnce);
    expect(markup).not.toContain(alwaysAllowSite);
  });

  test("without a signed-in account nothing can be stored", () => {
    expect(
      renderCard(browserPart(openNews, "approval-requested")),
    ).not.toContain(alwaysAllowSite);
  });

  test("a page read names the website the tab is on, as the extension reported it", () => {
    observeBrowserPage({
      revision: "revision-1",
      url: "https://example.com/search?q=lease",
      valueRefs: new Set(),
    });
    try {
      const markup = renderCard(
        browserPart(readPage, "approval-requested"),
        undefined,
        {
          user: member,
        },
      );
      expect(markup).toContain(alwaysAllowSite);
      expect(markup).toContain("example.com");
    } finally {
      observeBrowserPage(null);
    }
  });

  test("a page read with no page reported offers no website", () => {
    const markup = renderCard(
      browserPart(readPage, "approval-requested"),
      undefined,
      {
        user: member,
      },
    );
    expect(markup).not.toContain(alwaysAllowSite);
  });

  test("an answered card no longer offers it", () => {
    const markup = renderCard(
      browserPart(openNews, "complete", { status: "error" }),
      undefined,
      {
        user: member,
      },
    );
    expect(markup).not.toContain(alwaysAllowSite);
  });
});

test("a snapshot-denied approval remains denied when its result settles as an error", () => {
  const html = renderCard({
    ...browserPart(readPage, "error", { denied: true }),
    approval: { id: "approval-1", needsApproval: true, approved: false },
  });
  expect(html).toContain(messages.chat.approval.denied);
  expect(html).not.toContain(browserQuestion);
});
