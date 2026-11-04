import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type {
  ChatLocalRunReadiness,
  ChatRunTarget,
} from "@stll/api-contract/chat-run-target";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test/chat" });

const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { Menu, MenuPopup, MenuTrigger } = await import("@stll/ui/menu");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { localRunnersOptions } = await import("@/features/chat/queries");
const { ChatRunTargetMenu } = await import("./chat-run-target-menu");
const messages = (await import("@/i18n/langs/en.json")).default;

afterEach(cleanup);
afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";

/** One connected computer with Codex ready to take a run. */
const READINESS: ChatLocalRunReadiness = {
  status: "enabled",
  runners: [
    {
      desktopId: "0192f3a0-6b1c-7d2e-8f30-000000000001",
      connected: true,
      lastSeenAt: "2026-11-03T10:00:00.000Z",
      harnesses: [
        {
          id: "codex",
          state: "ready",
          version: "0.166.0",
          capabilities: ["approvals"],
          models: [{ id: "gpt-5-codex", label: "GPT-5 Codex" }],
        },
      ],
    },
  ],
};

const CODEX: ChatRunTarget = {
  kind: "local",
  harness: "codex",
  model: "gpt-5-codex",
};

test("the run-on group opens with its label, the cloud choice and a ready computer", async () => {
  const client = new QueryClient();
  client.setQueryData(localRunnersOptions(ORGANIZATION_ID).queryKey, READINESS);
  const chosen: ChatRunTarget[] = [];
  const view = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <Menu open>
            <MenuTrigger />
            <MenuPopup>
              <ChatRunTargetMenu
                activeOrganizationId={ORGANIZATION_ID}
                enabled={false}
                onSelect={(next) => {
                  chosen.push(next);
                }}
                selected={CODEX}
              />
            </MenuPopup>
          </Menu>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  expect(await waitFor(() => view.getByText("Run on"))).toBeTruthy();
  expect(view.getByText("Codex on this computer")).toBeTruthy();
  const cloud = view
    .getAllByRole("menuitemradio")
    .find((item) => item.textContent.includes("stella cloud"));
  expect(cloud).toBeDefined();
  if (cloud !== undefined) {
    fireEvent.click(cloud);
  }
  expect(chosen).toEqual([{ kind: "cloud" }]);
});
