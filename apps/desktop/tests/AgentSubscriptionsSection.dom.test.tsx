import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type {
  HarnessInstallState,
  HarnessStatus,
} from "../src/mainview/harness-install-status";

GlobalRegistrator.register({ url: "http://localhost/" });

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
const { emit } = await import("@tauri-apps/api/event");
const { DesktopIntlProvider, defaultMessages } = await import("../src/i18n");
const { AgentSubscriptionsSection } =
  await import("../src/mainview/AgentSubscriptionsSection");
const { HARNESS_INSTALL_CHANGED_EVENT } =
  await import("../src/mainview/harness-install-status");

afterEach(async () => {
  // A command's follow-up status read settles after a test's last
  // assertion; let React apply it while the DOM still exists.
  await act(async () => {
    // real-time: one macrotask lets the mocked IPC promises settle.
    await Bun.sleep(0);
  });
  cleanup();
  clearMocks();
});

afterAll(async () => {
  // React's scheduler runs on a macrotask; it must find the DOM it renders to.
  // real-time: one macrotask drains it before the DOM is removed.
  await Bun.sleep(0);
  await GlobalRegistrator.unregister();
});

const install = defaultMessages.agentSubscriptions.install;

/** The English message with its `{name}`-style arguments filled in. */
const message = (template: string, values: Record<string, string>) =>
  template.replaceAll(
    /\{(\w+)\}/gu,
    (_whole, key: string) => values[key] ?? "",
  );

type Call = { command: string; args: unknown };

/**
 * Renders the section over a native side whose harness status is
 * `harnesses()`, read again on every status request, with both
 * subscriptions signed out.
 */
const renderSection = (harnesses: () => unknown) => {
  const calls: Call[] = [];
  mockIPC(
    (command, args) => {
      calls.push({ command, args });
      switch (command) {
        case "chatgpt_auth_get_status": {
          return { state: "signed_out", sessionStored: false, accounts: [] };
        }
        case "claude_code_auth_get_status": {
          return { state: "not_installed" };
        }
        case "harness_get_status": {
          const value = harnesses();
          if (value instanceof Error) {
            throw value;
          }
          return value;
        }
        default: {
          return null;
        }
      }
    },
    { shouldMockEvents: true },
  );
  const view = render(
    <DesktopIntlProvider language="en" messages={defaultMessages}>
      <AgentSubscriptionsSection
        renderGroup={(content) => <section>{content}</section>}
      />
    </DesktopIntlProvider>,
  );
  return { ...view, calls };
};

const statuses = (
  codex: HarnessInstallState,
  claudeCode: HarnessInstallState,
) =>
  [
    { harness: "codex", state: codex },
    { harness: "claude-code", state: claudeCode },
  ] satisfies HarnessStatus[];

test("shows each download's progress and cancels that download", async () => {
  const { calls, findByText, getAllByRole } = renderSection(() =>
    statuses(
      {
        state: "downloading",
        operationId: "op-codex",
        version: "0.164.0",
        downloadedBytes: 50,
        totalBytes: 200,
        active: null,
      },
      {
        state: "verifying",
        operationId: "op-claude",
        version: "2.1.309",
        active: null,
      },
    ),
  );

  await findByText(
    message(install.downloading, {
      name: "Codex",
      version: "0.164.0",
      percent: "25",
    }),
  );
  await findByText(
    message(install.verifying, { name: "Claude Code", version: "2.1.309" }),
  );
  const cancels = getAllByRole("button", {
    name: defaultMessages.agentSubscriptions.cancel,
  });
  expect(cancels).toHaveLength(2);
  const claudeCodeCancel = cancels.at(1);
  if (claudeCodeCancel === undefined) {
    throw new Error("the Claude Code row has no cancel button");
  }
  fireEvent.click(claudeCodeCancel);

  await waitFor(() => {
    expect(
      calls.filter((call) => call.command === "harness_cancel_install"),
    ).toEqual([
      {
        command: "harness_cancel_install",
        args: { harness: "claude-code", operationId: "op-claude" },
      },
    ]);
  });
});

test("offers to install a missing CLI and says so once", async () => {
  const { calls, findByRole, queryAllByText } = renderSection(() =>
    statuses({ state: "ready", active: "0.164.0" }, { state: "not_installed" }),
  );

  const button = await findByRole("button", { name: install.install });
  // The sign-in status says the same; only the install line says it.
  expect(message(install.notInstalled, { name: "Claude Code" })).toBe(
    defaultMessages.agentSubscriptions.claudeCode.notInstalled,
  );
  expect(
    queryAllByText(defaultMessages.agentSubscriptions.claudeCode.notInstalled),
  ).toHaveLength(1);
  fireEvent.click(button);

  await waitFor(() => {
    expect(calls.filter((call) => call.command === "harness_install")).toEqual([
      { command: "harness_install", args: { harness: "claude-code" } },
    ]);
  });
});

test("reports a failed update, the release still in use, and retries", async () => {
  const { calls, findByRole } = renderSection(() =>
    statuses(
      { state: "failed", reason: "digest_mismatch", active: "0.150.0" },
      { state: "ready", active: "2.1.309" },
    ),
  );

  const alert = await findByRole("alert");
  expect(alert.textContent).toBe(
    `${message(install.failure.verification, { name: "Codex" })} ${message(
      install.activeStays,
      { version: "0.150.0" },
    )}`,
  );
  fireEvent.click(await findByRole("button", { name: install.retry }));

  await waitFor(() => {
    expect(calls.filter((call) => call.command === "harness_install")).toEqual([
      { command: "harness_install", args: { harness: "codex" } },
    ]);
  });
});

test("reads the status again when an install changes", async () => {
  let current: HarnessInstallState = {
    state: "downloading",
    operationId: "op-codex",
    version: "0.164.0",
    downloadedBytes: 0,
    totalBytes: 200,
    active: null,
  };
  const { findByText } = renderSection(() =>
    statuses(current, { state: "ready", active: "2.1.309" }),
  );
  await findByText(
    message(install.downloading, {
      name: "Codex",
      version: "0.164.0",
      percent: "0",
    }),
  );

  current = { state: "ready", active: "0.164.0" };
  await act(async () => {
    await emit(HARNESS_INSTALL_CHANGED_EVENT);
  });

  await findByText(
    message(install.ready, { name: "Codex", version: "0.164.0" }),
  );
});

test.each([
  ["refused (the feature is off)", () => new Error("feature_disabled")],
  ["malformed", () => [{ harness: "codex", state: { state: "downloading" } }]],
])(
  "shows the subscriptions without install lines when the status is %s",
  async (_case, harnesses) => {
    const { findByText, queryByRole } = renderSection(harnesses);

    await findByText(
      defaultMessages.agentSubscriptions.claudeCode.notInstalled,
    );
    expect(queryByRole("button", { name: install.install })).toBeNull();
    expect(queryByRole("status")).toBeNull();
  },
);
