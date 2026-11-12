import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type {
  ChatLocalRunReadiness,
  ChatLocalRunTarget,
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
const { ChatRunTargetMenu, LocalModelOptions } =
  await import("./chat-run-target-menu");
const messages = (await import("@/i18n/langs/en.json")).default;

afterEach(cleanup);
afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";

/**
 * One connected computer: Codex runs in its one mode and offers no effort
 * choice, and Claude Code cannot use its sandbox here.
 */
const READINESS: ChatLocalRunReadiness = {
  status: "enabled",
  runners: [
    {
      desktopId: "0192f3a0-6b1c-7d2e-8f30-000000000001",
      connected: true,
      lastSeenAt: "2026-11-03T10:00:00.000Z",
      linkedFolders: [],
      harnesses: [
        {
          id: "codex",
          state: "ready",
          version: "0.50.0",
          capabilities: ["approvals"],
          approvalModes: ["ask"],
          models: [
            { id: "gpt-5-codex", label: "GPT-5 Codex", reasoningEfforts: [] },
          ],
        },
        {
          id: "claude-code",
          state: "ready",
          version: "2.1.309",
          capabilities: ["approvals"],
          approvalModes: ["ask", "auto"],
          models: [
            {
              id: "sonnet",
              label: "Sonnet",
              reasoningEfforts: ["low", "high"],
            },
          ],
        },
      ],
    },
  ],
  maxApprovals: "full_auto",
};

const LOCAL: ChatLocalRunTarget = {
  kind: "local",
  harness: "claude-code",
  model: "sonnet",
  approvals: "ask",
  reasoningEffort: null,
};

const CODEX: ChatRunTarget = {
  kind: "local",
  harness: "codex",
  model: "gpt-5-codex",
  approvals: "ask",
  reasoningEffort: null,
};

const renderMenu = (
  selected: ChatRunTarget,
  readiness: ChatLocalRunReadiness = READINESS,
) => {
  const client = new QueryClient();
  client.setQueryData(localRunnersOptions(ORGANIZATION_ID).queryKey, readiness);
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

/** The model chip's menu for a chat on the member's computer. */
const renderModels = (selected: ChatLocalRunTarget) => {
  const client = new QueryClient();
  client.setQueryData(localRunnersOptions(ORGANIZATION_ID).queryKey, READINESS);
  const chosen: ChatRunTarget[] = [];
  const tree = (target: ChatLocalRunTarget) => (
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <Menu open>
            <MenuTrigger />
            <MenuPopup>
              <LocalModelOptions
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
    rerender: (target: ChatLocalRunTarget) => view.rerender(tree(target)),
  };
};

const radioItem = async (view: ReturnType<typeof render>, label: string) =>
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
  const ask = await radioItem(view, "Ask");
  const auto = await radioItem(view, "Auto");
  const fullAuto = await radioItem(view, "Full auto");
  expect(ask.getAttribute("aria-checked")).toBe("true");
  expect(auto.getAttribute("aria-checked")).toBe("false");
  expect(ask.getAttribute("aria-disabled")).not.toBe("true");
  expect(fullAuto.getAttribute("aria-disabled")).toBe("true");
  expect(fullAuto.textContent).toContain("Not available on this computer");
  expect(auto.textContent).toContain(
    "Does what it judges safe on its own; asks about the rest.",
  );
});

test("a mode above the organization's limit is disabled with that reason, apart from the ones the computer cannot run", async () => {
  const { view, chosen } = renderMenu(LOCAL, {
    ...READINESS,
    maxApprovals: "ask",
  });
  const auto = await radioItem(view, "Auto");
  const fullAuto = await radioItem(view, "Full auto");
  expect(auto.getAttribute("aria-disabled")).toBe("true");
  expect(auto.textContent).toContain("Not allowed by your organization");
  expect(fullAuto.textContent).toContain("Not available on this computer");
  fireEvent.click(auto);
  expect(chosen).toEqual([]);
});

test("choosing a permission mode keeps the harness and model, and the stored choice reads back as checked", async () => {
  const { view, chosen, rerender } = renderMenu(LOCAL);
  fireEvent.click(await radioItem(view, "Ask"));
  fireEvent.click(await radioItem(view, "Auto"));
  expect(chosen).toEqual([{ ...LOCAL, approvals: "auto" }]);
  rerender({ ...LOCAL, approvals: "auto" });
  expect((await radioItem(view, "Auto")).getAttribute("aria-checked")).toBe(
    "true",
  );
});

test("the model chip offers the model's reasoning efforts beside the harness default, and a choice keeps the model and permissions", async () => {
  const { view, chosen, rerender } = renderModels(LOCAL);
  expect(await waitFor(() => view.getByText("Reasoning effort"))).toBeTruthy();
  // The effort's own Default, not the recommended model above it.
  const effortDefault = async () =>
    await waitFor(() => {
      const item = view
        .getAllByRole("menuitemradio")
        .find(
          (candidate) =>
            candidate.textContent.replace(/^Selected/u, "") === "Default",
        );
      if (item === undefined) {
        throw new Error("no Default effort");
      }
      return item;
    });
  const harnessDefault = await effortDefault();
  expect(harnessDefault.getAttribute("aria-checked")).toBe("true");
  expect(view.queryByText("Medium")).toBeNull();
  fireEvent.click(await radioItem(view, "High"));
  expect(chosen).toEqual([{ ...LOCAL, reasoningEffort: "high" }]);
  rerender({ ...LOCAL, reasoningEffort: "high" });
  expect((await radioItem(view, "High")).getAttribute("aria-checked")).toBe(
    "true",
  );
  fireEvent.click(await effortDefault());
  expect(chosen.at(-1)).toEqual(LOCAL);
});

test("a harness that runs in one mode offers no choice and says how it behaves", async () => {
  const { view } = renderMenu(CODEX);
  expect(
    await waitFor(() =>
      view.getByText("Runs in a sandbox; asks before changing your computer."),
    ),
  ).toBeTruthy();
  expect(view.getByText("Permissions")).toBeTruthy();
  // The places alone: no permission mode to pick.
  expect(
    view
      .getAllByRole("menuitemradio")
      .map((item) => item.textContent.replace(/^Selected/u, "")),
  ).toEqual([
    `${messages.chat.runOn.cloud}${messages.chat.runOn.cloudDescription}`,
    "Codex",
    "Claude Code",
  ]);
});

test("a cloud turn has no permission choice", async () => {
  const { view } = renderMenu({ kind: "cloud" });
  await waitFor(() => view.getByText(messages.chat.runOn.yourComputer));
  expect(view.queryByText("Permissions")).toBeNull();
});

test("the places open with the cloud, the member's computer and its ready agents", async () => {
  const { view, chosen } = renderMenu(CODEX);
  expect(
    await waitFor(() => view.getByText(messages.chat.runOn.yourComputer)),
  ).toBeTruthy();
  expect(view.getByText("Codex")).toBeTruthy();
  const cloud = view
    .getAllByRole("menuitemradio")
    .find((item) => item.textContent.includes(messages.chat.runOn.cloud));
  expect(cloud).toBeDefined();
  if (cloud !== undefined) {
    fireEvent.click(cloud);
  }
  expect(chosen).toEqual([{ kind: "cloud" }]);
});

test("picking another agent starts it on its recommended model, and the chosen agent keeps its own", async () => {
  const { view, chosen } = renderMenu(CODEX);
  const claude = await waitFor(() => {
    const item = view
      .getAllByRole("menuitemradio")
      .find((candidate) => candidate.textContent.endsWith("Claude Code"));
    if (item === undefined) {
      throw new Error("no Claude Code choice");
    }
    return item;
  });
  fireEvent.click(claude);
  expect(chosen).toEqual([LOCAL]);
});
