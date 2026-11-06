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

/**
 * One connected computer: Codex runs in its one mode, and Claude Code cannot
 * use its sandbox here.
 */
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
          version: "0.50.0",
          capabilities: ["approvals"],
          approvalModes: ["ask"],
          models: [{ id: "gpt-5-codex", label: "GPT-5 Codex" }],
        },
        {
          id: "claude-code",
          state: "ready",
          version: "2.1.309",
          capabilities: ["approvals"],
          approvalModes: ["ask", "auto"],
          models: [{ id: "sonnet", label: "Sonnet" }],
        },
      ],
    },
  ],
};

const LOCAL: ChatRunTarget = {
  kind: "local",
  harness: "claude-code",
  model: "sonnet",
  approvals: "ask",
};

const CODEX: ChatRunTarget = {
  kind: "local",
  harness: "codex",
  model: "gpt-5-codex",
  approvals: "ask",
};

const renderMenu = (selected: ChatRunTarget) => {
  const client = new QueryClient();
  client.setQueryData(localRunnersOptions(ORGANIZATION_ID).queryKey, READINESS);
  const chosen: ChatRunTarget[] = [];
  const tree = (target: ChatRunTarget) => (
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
                selected={target}
              />
            </MenuPopup>
          </Menu>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>
  );
  const view = render(tree(selected));
  return {
    view,
    chosen,
    rerender: (target: ChatRunTarget) => view.rerender(tree(target)),
  };
};

const permissionItem = async (view: ReturnType<typeof render>, label: string) =>
  await waitFor(() => {
    const item = view.getAllByRole("menuitemradio").find((candidate) =>
      // A checked item starts with its indicator's "Selected" title.
      candidate.textContent.replace(/^Selected/u, "").startsWith(label),
    );
    if (item === undefined) {
      throw new Error(`no ${label} choice`);
    }
    return item;
  });

test("a local turn offers every permission mode, and the ones this computer cannot run are disabled with why", async () => {
  const { view } = renderMenu(LOCAL);
  expect(await waitFor(() => view.getByText("Permissions"))).toBeTruthy();
  const ask = await permissionItem(view, "Ask");
  const auto = await permissionItem(view, "Auto");
  const fullAuto = await permissionItem(view, "Full auto");
  expect(ask.getAttribute("aria-checked")).toBe("true");
  expect(auto.getAttribute("aria-checked")).toBe("false");
  expect(ask.getAttribute("aria-disabled")).not.toBe("true");
  expect(fullAuto.getAttribute("aria-disabled")).toBe("true");
  expect(fullAuto.textContent).toContain("Not available on this computer");
  expect(auto.textContent).toContain(
    "Does what it judges safe on its own; asks about the rest.",
  );
});

test("choosing a permission mode keeps the harness and model, and the stored choice reads back as checked", async () => {
  const { view, chosen, rerender } = renderMenu(LOCAL);
  fireEvent.click(await permissionItem(view, "Ask"));
  fireEvent.click(await permissionItem(view, "Auto"));
  expect(chosen).toEqual([{ ...LOCAL, approvals: "auto" }]);
  rerender({ ...LOCAL, approvals: "auto" });
  expect(
    (await permissionItem(view, "Auto")).getAttribute("aria-checked"),
  ).toBe("true");
});

test("a harness that runs in one mode offers no choice and says how it behaves", async () => {
  const { view } = renderMenu(CODEX);
  expect(
    await waitFor(() =>
      view.getByText("Runs in a sandbox; asks before changing your computer."),
    ),
  ).toBeTruthy();
  expect(view.getByText("Permissions")).toBeTruthy();
  expect(
    view
      .getAllByRole("menuitemradio")
      .map((item) => item.textContent.replace(/^Selected/u, "")),
  ).toEqual(["stella cloud"]);
});

test("a cloud turn has no permission choice", async () => {
  const { view } = renderMenu({ kind: "cloud" });
  await waitFor(() => view.getByText("Run on"));
  expect(view.queryByText("Permissions")).toBeNull();
});

test("the run-on group opens with its label, the cloud choice and a ready computer", async () => {
  const { view, chosen } = renderMenu(CODEX);
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
