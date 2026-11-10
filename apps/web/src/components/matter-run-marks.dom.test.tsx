import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import type {
  ChatActiveRun,
  ChatTurnInteractionType,
} from "@stll/api-contract/chat";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { MatterRuns } from "@/features/chat/active-runs.logic";
import arabicMessages from "@/i18n/langs/ar.json";
import czechMessages from "@/i18n/langs/cs.json";
import englishMessages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { MatterRunBadge, MatterRunMarks } = await import("./matter-run-marks");

afterEach(() => {
  cleanup();
});
afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

const MATTER_ID = "matter_spa";
const SINCE = "2026-11-10T09:00:00.000Z";

const waiting = (threadId: string, interaction: ChatTurnInteractionType) =>
  ({
    interaction,
    since: SINCE,
    state: "needs-you",
    threadId,
    threadTitle: threadId,
    workspaceId: MATTER_ID,
  }) satisfies ChatActiveRun;

const working = (threadId: string) =>
  ({
    since: SINCE,
    state: "working",
    threadId,
    threadTitle: threadId,
    workspaceId: MATTER_ID,
  }) satisfies ChatActiveRun;

/** A matter with `needsYou` waiting approvals and `working` chats at work. */
const runsOf = ({
  needsYou,
  working: workingCount,
}: {
  needsYou: number;
  working: number;
}): MatterRuns => ({
  needsYou: Array.from({ length: needsYou }, (_, index) =>
    waiting(`waiting-${index}`, "approval"),
  ),
  working: Array.from({ length: workingCount }, (_, index) =>
    working(`working-${index}`),
  ),
});

const Providers = ({
  children,
  locale,
}: React.PropsWithChildren<{ locale: "ar" | "cs" | "en" }>) => (
  <IntlProvider
    locale={locale}
    messages={
      { ar: arabicMessages, cs: czechMessages, en: englishMessages }[locale]
    }
    timeZone="UTC"
  >
    <FormattingProvider locale={locale} timeZone="UTC">
      {children}
    </FormattingProvider>
  </IntlProvider>
);

const renderIn = (node: React.ReactNode, locale: "ar" | "cs" | "en" = "en") =>
  render(<Providers locale={locale}>{node}</Providers>);

/** The badge renders thread links, so it mounts under a router. */
const renderInRouter = async (node: React.ReactNode) => {
  const rootRoute = router.createRootRoute({
    component: () => (
      <Providers locale="en">
        <div data-testid="rail">{node}</div>
      </Providers>
    ),
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/"] }),
    isServer: false,
    routeTree: rootRoute,
  });
  await appRouter.load();
  const view = render(<router.RouterProvider router={appRouter} />);
  await waitFor(() => view.getByTestId("rail"));
  return view;
};

const labels = (container: HTMLElement) =>
  [...container.querySelectorAll("[role='img']")].map((element) =>
    element.getAttribute("aria-label"),
  );

describe("MatterRunMarks", () => {
  test("a matter with no open chat renders nothing", () => {
    expect(
      renderIn(<MatterRunMarks runs={undefined} />).container.innerHTML,
    ).toBe("");
    expect(
      renderIn(<MatterRunMarks runs={runsOf({ needsYou: 0, working: 0 })} />)
        .container.innerHTML,
    ).toBe("");
  });

  test("chats waiting on the reader come before chats at work, each named", () => {
    const { container } = renderIn(
      <MatterRunMarks runs={runsOf({ needsYou: 1, working: 3 })} />,
    );
    expect(labels(container)).toEqual([
      "1 chat is waiting for you",
      "3 chats are working",
    ]);
  });

  test("a count follows a mark only when there is more than one", () => {
    const { container } = renderIn(
      <MatterRunMarks runs={runsOf({ needsYou: 1, working: 3 })} />,
    );
    const [needsYou, workingMark] = container.querySelectorAll("[role='img']");
    expect(needsYou?.textContent).toBe("!");
    expect(workingMark?.textContent).toBe("3");
  });

  test("labels follow each locale's plural rules", () => {
    expect(
      labels(
        renderIn(
          <MatterRunMarks runs={runsOf({ needsYou: 2, working: 5 })} />,
          "cs",
        ).container,
      ),
    ).toEqual(["Na vás čekají 2 chaty", "Pracuje 5 chatů"]);
    expect(
      labels(
        renderIn(
          <MatterRunMarks runs={runsOf({ needsYou: 2, working: 0 })} />,
          "ar",
        ).container,
      ),
    ).toEqual(["دردشتان بانتظارك"]);
  });
});

describe("MatterRunBadge", () => {
  const badge = (container: HTMLElement) =>
    container.querySelector("[data-slot='matter-run-badge']");

  test("shows only the state that matters most, named in full", async () => {
    const { container } = await renderInRouter(
      <MatterRunBadge
        runs={runsOf({ needsYou: 2, working: 4 })}
        workspaceId={MATTER_ID}
      />,
    );
    expect(badge(container)?.textContent).toBe("!");
    expect(badge(container)?.getAttribute("aria-label")).toBe(
      "2 chats are waiting for you, 4 chats are working",
    );
  });

  test("a matter with nothing open has no badge", async () => {
    const { container } = await renderInRouter(
      <MatterRunBadge runs={undefined} workspaceId={MATTER_ID} />,
    );
    expect(badge(container)).toBeNull();
  });

  test("opens the matter's open chats, each saying what it waits on and linking to it", async () => {
    const view = await renderInRouter(
      <MatterRunBadge
        runs={{
          needsYou: [
            waiting("lease-question", "ask-user"),
            waiting("filing-approval", "approval"),
            waiting("draft-build", "client-tool"),
            waiting("local-agent", "harness-question"),
          ],
          working: [working("summary")],
        }}
        workspaceId={MATTER_ID}
      />,
    );
    const trigger = badge(view.container);
    if (trigger === null) {
      return panic("The badge did not render");
    }
    fireEvent.click(trigger);

    const rows = await waitFor(() => {
      const links = [
        ...document.querySelectorAll<HTMLAnchorElement>("li a[href]"),
      ];
      expect(links).toHaveLength(5);
      return links;
    });
    expect(rows.map((row) => row.getAttribute("href"))).toEqual(
      [
        "lease-question",
        "filing-approval",
        "draft-build",
        "local-agent",
        "summary",
      ].map((threadId) => `/chat/workspaces/${MATTER_ID}/${threadId}`),
    );
    expect(rows.map((row) => row.textContent.split(" · ")[0])).toEqual([
      "!lease-questionAsks you a question",
      "!filing-approvalNeeds your approval",
      "!draft-buildContinues when you open this chat",
      "!local-agentThe agent on your computer has a question",
      "summaryWorking",
    ]);
  });
});
