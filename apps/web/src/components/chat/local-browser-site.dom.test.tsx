import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { CHAT_LOCAL_RUN_TOOL_NAMES } from "@stll/api-contract/chat-local-run-tool";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import { testChatApprovalContextValue } from "@/components/chat/chat-approval-context.test-fixtures";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { cleanup, fireEvent, render, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { ChatApprovalContext } = await import("./chat-approval-context");
const { ToolApprovalCard } = await import("./tool-approval-card");
const { localBrowserApprovalSite } = await import("./local-browser-site");
const { browserSiteGrantsOptions } =
  await import("@/features/chat/browser-control/browser-site-grants");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { toSafeId } = await import("@/lib/safe-id");

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

const SITE = "https://fixture-library.test";
const ALWAYS_ALLOW_SITE = messages.chat.approval.browser.alwaysAllowSite;

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

const askedStep = (url: string, action = "click") => ({
  action,
  asked: { name: "Search", role: "button", url },
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
            <ToolApprovalCard
              isAwaitingUser
              isTurnActive={false}
              part={localBrowserPart(input)}
            />
          </ChatApprovalContext>
        </IntlProvider>
      </AuthenticatedUserProvider>
    </QueryClientProvider>,
  );
  return { approvedForRun, approvedOnce, queryClient, view };
};

describe("always allowing a website from a step on the member's computer", () => {
  test("names the exact origin of the page the desktop read", () => {
    const { browser } = CHAT_LOCAL_RUN_TOOL_NAMES;
    expect(
      localBrowserApprovalSite(browser, askedStep(`${SITE}/search?q=x`)),
    ).toBe(SITE);
    expect(
      localBrowserApprovalSite(
        browser,
        askedStep("http://fixture-library.test/"),
      ),
    ).toBeNull();
    expect(
      localBrowserApprovalSite(browser, { action: "open", url: `${SITE}/` }),
    ).toBeNull();
    expect(
      localBrowserApprovalSite("web_search", askedStep(`${SITE}/`)),
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

  test("a website already allowed is not offered again", () => {
    const { queryClient, view } = renderLocalCard(askedStep(`${SITE}/search`), {
      allowed: [SITE],
    });
    expect(
      within(view.container).queryByRole("button", { name: ALWAYS_ALLOW_SITE }),
    ).toBeNull();
    queryClient.clear();
  });
});
