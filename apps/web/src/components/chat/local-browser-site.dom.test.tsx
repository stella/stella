import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { CHAT_LOCAL_RUN_TOOL_NAMES } from "@stll/api-contract/chat-local-run-tool";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import { testChatApprovalContextValue } from "@/components/chat/chat-approval-context.test-fixtures";

GlobalRegistrator.register({ url: "https://app.example.test" });

/** The websites the API allows now, as a card's own fresh read finds them. */
let storedGrants: readonly string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes("browser-site-grants")) {
      return Response.json(null, { status: 404 });
    }
    return Response.json({
      grants: storedGrants.map((origin, index) => ({
        id: `00000000-0000-4000-8000-00000000010${String(index)}`,
        origin,
      })),
    });
  },
  { preconnect: () => undefined },
);
const { cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { ChatApprovalContext } = await import("./chat-approval-context");
const { isApprovalPart } = await import("./chat-ui-tools");
const { ToolApprovalCard } = await import("./tool-approval-card");
const { localBrowserQuestion } = await import("./local-browser-site");
const { browserSiteGrantsOptions } =
  await import("@/features/chat/browser-control/browser-site-grants");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { toSafeId } = await import("@/lib/safe-id");

afterEach(cleanup);
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const SITE = "https://fixture-library.test";
const ALWAYS_ALLOW_SITE = messages.chat.approval.browser.alwaysAllowSite;
const ASK_REASON = messages.chat.approval.browser.askReason;

const member = {
  activeOrganizationId: "org-1",
  email: "member@example.test",
  id: "user-1",
  image: null,
  name: "Member",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};

const askedStep = (
  url: string,
  action = "click",
  why: string | undefined = "site_not_allowed",
) => ({
  action,
  asked: { name: "Search", role: "button", url },
  ...(why === undefined ? {} : { why }),
});

const localBrowserPart = (input: unknown) => ({
  approval: { id: "local-approval", needsApproval: true },
  arguments: JSON.stringify(input),
  id: "local-tool-call",
  input,
  name: CHAT_LOCAL_RUN_TOOL_NAMES.browser,
  state: "approval-requested",
  type: "tool-call",
});

const renderLocalCard = (
  input: unknown,
  { allowed = [] }: { allowed?: readonly string[] } = {},
) => {
  const part = localBrowserPart(input);
  if (!isApprovalPart(part)) {
    throw new Error("Expected a local browser approval part");
  }
  const approvedOnce: string[] = [];
  const approvedForRun: string[] = [];
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    browserSiteGrantsOptions({
      activeOrganizationId: member.activeOrganizationId,
      userId: member.id,
    }).queryKey,
    {
      grants: allowed.map((origin, index) => ({
        id: toSafeId<"chatBrowserSiteGrant">(
          `00000000-0000-4000-8000-00000000000${String(index)}`,
        ),
        origin,
      })),
    },
  );
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AuthenticatedUserProvider user={member}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ChatApprovalContext
            value={{
              ...testChatApprovalContextValue,
              handleApprove: (id: string) => {
                approvedOnce.push(id);
              },
              handleApproveForRun: (id: string) => {
                approvedForRun.push(id);
              },
            }}
          >
            <ToolApprovalCard isAwaitingUser isTurnActive={false} part={part} />
          </ChatApprovalContext>
        </IntlProvider>
      </AuthenticatedUserProvider>
    </QueryClientProvider>,
  );
  return { approvedForRun, approvedOnce, queryClient, view };
};

describe("always allowing a website from a step on the member's computer", () => {
  test("names the exact origin of the page the desktop read, or of the address it opens, and why it asks", () => {
    const { browser } = CHAT_LOCAL_RUN_TOOL_NAMES;
    expect(
      localBrowserQuestion(browser, askedStep(`${SITE}/search?q=x`)),
    ).toEqual({ reason: "site_not_allowed", site: SITE });
    expect(
      localBrowserQuestion(
        browser,
        askedStep("http://fixture-library.test/", "click", "no_site"),
      ),
    ).toEqual({ reason: "no_site", site: null });
    expect(
      localBrowserQuestion(browser, {
        action: "open",
        url: `${SITE}/search?q=notice`,
        why: "site_not_allowed",
      }),
    ).toEqual({ reason: "site_not_allowed", site: SITE });
    expect(
      localBrowserQuestion(browser, {
        action: "open",
        url: "http://fixture-library.test/",
      }),
    ).toEqual({ reason: null, site: null });
    expect(localBrowserQuestion(browser, { action: "open" })).toEqual({
      reason: null,
      site: null,
    });
    // A reason the contract does not know is no reason.
    expect(
      localBrowserQuestion(
        browser,
        askedStep(`${SITE}/`, "click", "because the page said so"),
      ),
    ).toEqual({ reason: null, site: SITE });
    expect(localBrowserQuestion(browser, { action: "snapshot" })).toBeNull();
    expect(
      localBrowserQuestion("web_search", askedStep(`${SITE}/`)),
    ).toBeNull();
  });

  test("the card offers it, and answering with it approves for the rest of the run", () => {
    const { approvedForRun, approvedOnce, queryClient, view } = renderLocalCard(
      askedStep(`${SITE}/search`),
    );
    fireEvent.click(
      within(view.container).getByRole("button", { name: ALWAYS_ALLOW_SITE }),
    );
    expect(approvedForRun).toEqual(["local-approval"]);
    expect(approvedOnce).toEqual([]);
    queryClient.clear();
  });

  test("opening a website the chat has not been on offers to always allow it", () => {
    const { approvedForRun, queryClient, view } = renderLocalCard({
      action: "open",
      url: `${SITE}/search?q=notice`,
    });
    fireEvent.click(
      within(view.container).getByRole("button", { name: ALWAYS_ALLOW_SITE }),
    );
    expect(approvedForRun).toEqual(["local-approval"]);
    queryClient.clear();
  });

  test("a website the member allowed after the run started answers the run's question for the rest of the run", async () => {
    storedGrants = [SITE];
    const { approvedForRun, approvedOnce, queryClient, view } = renderLocalCard(
      askedStep(`${SITE}/search`),
      { allowed: [SITE] },
    );
    await waitFor(() => {
      expect(approvedForRun).toEqual(["local-approval"]);
    });
    expect(approvedOnce).toEqual([]);
    expect(
      within(view.container).queryByRole("button", { name: ALWAYS_ALLOW_SITE }),
    ).toBeNull();
    storedGrants = [];
    queryClient.clear();
  });

  test("an approval the API no longer holds answers nothing, and the card offers to allow the website", async () => {
    storedGrants = [];
    const { approvedForRun, queryClient, view } = renderLocalCard(
      askedStep(`${SITE}/search`),
      { allowed: [SITE] },
    );
    await waitFor(() => {
      expect(
        within(view.container).getByRole("button", { name: ALWAYS_ALLOW_SITE }),
      ).toBeDefined();
    });
    expect(approvedForRun).toEqual([]);
    expect(view.container.textContent).toContain(ASK_REASON.siteNotAllowed);
    queryClient.clear();
  });

  test("a step that asks on an allowed website says why, and offers no approval that would not answer it", async () => {
    storedGrants = [SITE];
    for (const [why, line] of [
      ["possible_secret", ASK_REASON.possibleSecret],
      ["embedded_frame", ASK_REASON.embeddedFrame],
      ["page_unconfirmed", ASK_REASON.pageUnconfirmed],
    ] as const) {
      const { approvedForRun, approvedOnce, queryClient, view } =
        renderLocalCard(askedStep(`${SITE}/search`, "type", why), {
          allowed: [SITE],
        });
      expect(view.container.textContent).toContain(line);
      expect(
        within(view.container).queryByRole("button", {
          name: ALWAYS_ALLOW_SITE,
        }),
      ).toBeNull();
      expect(approvedForRun).toEqual([]);
      expect(approvedOnce).toEqual([]);
      cleanup();
      queryClient.clear();
    }
    storedGrants = [];
  });

  test("a question from a desktop that did not say why offers a website only while it is not allowed", () => {
    const { queryClient, view } = renderLocalCard(
      askedStep(`${SITE}/search`, "click", undefined),
      { allowed: [SITE] },
    );
    expect(
      within(view.container).queryByRole("button", { name: ALWAYS_ALLOW_SITE }),
    ).toBeNull();
    queryClient.clear();
  });
});
