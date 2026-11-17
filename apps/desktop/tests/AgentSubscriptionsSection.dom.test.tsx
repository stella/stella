import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import {
  drainReactScheduler,
  unregisterDomEnvironment,
} from "@stll/property-testing/dom-environment";

import type { AgentSettingsFocus } from "../src/mainview/AgentSubscriptionsSection";
import type {
  HarnessInstallState,
  HarnessStatus,
} from "../src/mainview/harness-install-status";

GlobalRegistrator.register({ url: "http://localhost/" });

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { useState } = await import("react");
const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
const { emit } = await import("@tauri-apps/api/event");
const { DesktopIntlProvider, defaultMessages } = await import("../src/i18n");
const { AgentSubscriptionsSection } =
  await import("../src/mainview/AgentSubscriptionsSection");
const { HARNESS_INSTALL_CHANGED_EVENT } =
  await import("../src/mainview/harness-install-status");

afterEach(async () => {
  await act(async () => {
    await drainReactScheduler();
  });
  cleanup();
  clearMocks();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

const install = defaultMessages.agentSubscriptions.install;

/** The English message with its `{name}`-style arguments filled in. */
const message = (template: string, values: Record<string, string>) =>
  template.replaceAll(
    /\{(\w+)\}/gu,
    (_whole, key: string) => values[key] ?? "",
  );

type Call = { command: string; args: unknown };

const LINK_FOCUSES = [
  "agents",
  "codex",
  "claude-code",
] as const satisfies readonly AgentSettingsFocus[];

/** What the native side reports, read again on every status request. */
type NativeSide = {
  harnesses: () => unknown;
  chatGpt?: () => unknown;
  claudeCode?: () => unknown;
  /** Runs when a sign-in is started. */
  onStart?: (command: string) => void;
};

const SIGNED_OUT_CHATGPT = {
  state: "signed_out",
  sessionStored: false,
  accounts: [],
};

/**
 * Renders the section over `native`, with ChatGPT signed out and Claude Code
 * not installed unless it says otherwise, and `focus` requested by a
 * settings link. The page clears a request once it is shown, as App does;
 * `sendLink` requests another.
 */
const renderSection = (
  native: NativeSide | (() => unknown),
  focus: AgentSettingsFocus | null = null,
) => {
  const {
    harnesses,
    chatGpt = () => SIGNED_OUT_CHATGPT,
    claudeCode = () => ({ state: "not_installed" }),
    onStart,
  } = typeof native === "function" ? { harnesses: native } : native;
  const shown: AgentSettingsFocus[] = [];
  const calls: Call[] = [];
  mockIPC(
    (command, args) => {
      calls.push({ command, args });
      switch (command) {
        case "chatgpt_auth_get_status": {
          return chatGpt();
        }
        case "claude_code_auth_get_status": {
          return claudeCode();
        }
        case "harness_get_status": {
          const value = harnesses();
          if (value instanceof Error) {
            throw value;
          }
          return value;
        }
        case "chatgpt_auth_start":
        case "claude_code_auth_start": {
          onStart?.(command);
          return null;
        }
        default: {
          return null;
        }
      }
    },
    { shouldMockEvents: true },
  );
  // A link arriving again is a click on one of these, outside the section.
  const Page = () => {
    const [requested, setRequested] = useState(focus);
    return (
      <>
        {LINK_FOCUSES.map((link) => (
          <button
            key={link}
            onClick={() => {
              setRequested(link);
            }}
            type="button"
          >
            {`link ${link}`}
          </button>
        ))}
        <AgentSubscriptionsSection
          focus={requested}
          onFocusShown={() => {
            if (requested !== null) {
              shown.push(requested);
            }
            setRequested(null);
          }}
          renderGroup={(content) => <section>{content}</section>}
        />
      </>
    );
  };
  const view = render(
    <DesktopIntlProvider language="en" messages={defaultMessages}>
      <Page />
    </DesktopIntlProvider>,
  );
  const sendLink = async (next: AgentSettingsFocus) => {
    fireEvent.click(view.getByRole("button", { name: `link ${next}` }));
    await act(async () => {
      await drainReactScheduler();
    });
  };
  /** The sign-ins started so far, by command. */
  const starts = () =>
    calls
      .filter(
        ({ command }) =>
          command === "chatgpt_auth_start" ||
          command === "claude_code_auth_start",
      )
      .map(({ command, args }) => ({ command, args }));
  return { ...view, calls, shown, sendLink, starts };
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

test("a settings link's agent card is brought into view, focused and marked once it shows", async () => {
  const { findByText, shown, starts } = renderSection(
    () => statuses({ state: "not_installed" }, { state: "not_installed" }),
    "claude-code",
  );
  const claudeCode = (
    await findByText(message(install.notInstalled, { name: "Claude Code" }))
  ).closest<HTMLElement>("[data-agent-settings]");
  expect(claudeCode?.dataset["agentSettings"]).toBe("claude-code");
  await waitFor(() => {
    expect(document.activeElement).toBe(claudeCode);
  });
  expect(claudeCode?.dataset["highlighted"]).toBe("");
  const codex = (
    await findByText(message(install.notInstalled, { name: "Codex" }))
  ).closest<HTMLElement>("[data-agent-settings]");
  expect(codex?.dataset["agentSettings"]).toBe("codex");
  expect(codex?.dataset["highlighted"]).toBeUndefined();
  expect(shown).toEqual(["claude-code"]);
  // Nothing to sign in to before Claude Code is installed.
  expect(starts()).toEqual([]);
});

const NOT_INSTALLED = () =>
  statuses({ state: "not_installed" }, { state: "not_installed" });

/** Waits until the link's card was shown, and every effect has run. */
const settled = async (shown: AgentSettingsFocus[], count = 1) => {
  await waitFor(() => {
    expect(shown).toHaveLength(count);
  });
  await act(async () => {
    await drainReactScheduler();
  });
};

test("a link to a signed-out ChatGPT starts its sign-in once, and a repeated link while it runs starts nothing", async () => {
  let chatGpt: unknown = SIGNED_OUT_CHATGPT;
  const { shown, sendLink, starts } = renderSection(
    {
      harnesses: NOT_INSTALLED,
      chatGpt: () => chatGpt,
      onStart: () => {
        chatGpt = { state: "signing_in", sessionStored: false, accounts: [] };
      },
    },
    "codex",
  );
  await settled(shown);
  expect(starts()).toEqual([
    {
      command: "chatgpt_auth_start",
      args: { account: null, newAccount: false },
    },
  ]);

  await waitFor(() => {
    expect(
      document.body.textContent.includes(
        defaultMessages.agentSubscriptions.signingIn,
      ),
    ).toBe(true);
  });
  await sendLink("codex");
  await settled(shown, 2);
  expect(starts()).toHaveLength(1);
});

test("a link to ChatGPT continues as the one account the card offers", async () => {
  const { shown, starts } = renderSection(
    {
      harnesses: NOT_INSTALLED,
      chatGpt: () => ({
        state: "needs_reconnect",
        email: null,
        sessionStored: true,
        accounts: [{ id: "account-1", email: "lawyer@example.test" }],
      }),
    },
    "codex",
  );
  await settled(shown);
  expect(starts()).toEqual([
    {
      command: "chatgpt_auth_start",
      args: { account: "account-1", newAccount: false },
    },
  ]);
});

test.each([
  [
    "connected",
    {
      state: "connected",
      email: null,
      plan: null,
      sessionStored: true,
      accounts: [],
    },
  ],
  ["signing in", { state: "signing_in", sessionStored: false, accounts: [] }],
])(
  "a link to ChatGPT while it is %s only brings the card into view",
  async (_label, chatGpt) => {
    const { shown, starts } = renderSection(
      { harnesses: NOT_INSTALLED, chatGpt: () => chatGpt },
      "codex",
    );
    await settled(shown);
    expect(starts()).toEqual([]);
  },
);

test("a link to the whole group starts no sign-in", async () => {
  const { shown, starts } = renderSection(
    {
      harnesses: NOT_INSTALLED,
      claudeCode: () => ({ state: "signed_out" }),
    },
    "agents",
  );
  await settled(shown);
  expect(starts()).toEqual([]);
});

test.each([
  ["signed out", { state: "signed_out" }, 1],
  ["signed in with an API key", { state: "api_key" }, 1],
  ["signed in", { state: "signed_in", email: null, plan: null }, 0],
  ["signing in", { state: "signing_in", signInPage: false }, 0],
] as const)(
  "a link to Claude Code %s starts its sign-in only when it needs one",
  async (_label, claudeCode, expected) => {
    const { shown, starts } = renderSection(
      { harnesses: NOT_INSTALLED, claudeCode: () => claudeCode },
      "claude-code",
    );
    await settled(shown);
    expect(starts()).toEqual(
      Array.from({ length: expected }, () => ({
        command: "claude_code_auth_start",
        args: {},
      })),
    );
  },
);
