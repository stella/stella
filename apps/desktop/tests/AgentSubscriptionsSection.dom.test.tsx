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
const { NativeStatusMemoryProvider } =
  await import("../src/mainview/native-status-memory");
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
  antigravity?: () => unknown;
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
    antigravity = () => null,
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
        case "antigravity_get_status": {
          return antigravity();
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
      {
        version: "0.150.0",
      },
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
  ).closest<HTMLElement>("[data-settings-target]");
  expect(claudeCode?.dataset["settingsTarget"]).toBe("agents-claude-code");
  await waitFor(() => {
    expect(document.activeElement).toBe(claudeCode);
  });
  expect(claudeCode?.dataset["highlighted"]).toBe("");
  const codex = (
    await findByText(message(install.notInstalled, { name: "Codex" }))
  ).closest<HTMLElement>("[data-settings-target]");
  expect(codex?.dataset["settingsTarget"]).toBe("agents-codex");
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

const antigravityMessages = defaultMessages.agentSubscriptions.antigravity;

/** What the native side answers for the member's Antigravity CLI. */
type AntigravityAnswer =
  | { state: "not_installed" }
  | { state: "too_old" | "signed_out" | "signed_in"; version: string }
  | {
      state: "unchecked";
      version: string;
      reason: "not_connected" | "check_failed";
    };

/**
 * Renders the section with only the Antigravity CLI, answering each status
 * read from `answers` in turn; a read can be held open until the test
 * settles it, as a probe of the CLI takes a moment.
 */
const renderAntigravity = (first: AntigravityAnswer) => {
  let next: () => Promise<unknown> = async () => first;
  const view = renderSection({
    harnesses: () => [],
    antigravity: async () => next(),
  });
  /** The next read waits for the returned settle function. */
  const holdNext = () => {
    let settle: (answer: AntigravityAnswer | Error) => void = () => undefined;
    const held = new Promise<unknown>((resolve, reject) => {
      settle = (answer) => {
        if (answer instanceof Error) {
          reject(answer);
        } else {
          resolve(answer);
        }
      };
    });
    next = async () => held;
    return (answer: AntigravityAnswer | Error) => {
      settle(answer);
    };
  };
  const checkAgain = () =>
    view.getByRole("button", { name: antigravityMessages.checkAgain });
  const statusLine = () =>
    view
      .getByText(antigravityMessages.title)
      .closest("li")
      ?.querySelector('[role="status"]')?.textContent ?? null;
  return { ...view, holdNext, checkAgain, statusLine };
};

test.each([
  [
    { state: "signed_in", version: "1.5.17" },
    defaultMessages.agentSubscriptions.signedIn,
  ],
  [{ state: "signed_out", version: "1.5.17" }, antigravityMessages.signedOut],
  [{ state: "too_old", version: "1.4.2" }, antigravityMessages.tooOld],
  [{ state: "not_installed" }, antigravityMessages.notInstalled],
  [
    { state: "unchecked", version: "1.5.17", reason: "not_connected" },
    antigravityMessages.notConnected,
  ],
  [
    { state: "unchecked", version: "1.5.17", reason: "check_failed" },
    antigravityMessages.checkFailed,
  ],
] satisfies [AntigravityAnswer, string][])(
  "the Antigravity row says what the CLI answered: %o",
  async (answer, expected) => {
    const { statusLine, queryByText } = renderAntigravity(answer);
    await waitFor(() => {
      expect(statusLine()).toBe(expected);
    });
    const installed =
      answer.state === "not_installed"
        ? null
        : message(install.ready, {
            name: antigravityMessages.title,
            version: answer.version,
          });
    if (installed !== null) {
      expect(queryByText(installed)).not.toBeNull();
    }
  },
);

test("Check again shows the check running, then what the CLI answered", async () => {
  const { checkAgain, holdNext, statusLine, calls, queryByRole } =
    renderAntigravity({
      state: "signed_out",
      version: "1.5.17",
    });
  await waitFor(() => {
    expect(statusLine()).toBe(antigravityMessages.signedOut);
  });

  // Still signed out: the answer says it was looked at.
  let settle = holdNext();
  fireEvent.click(checkAgain());
  await waitFor(() => {
    expect(statusLine()).toBe(antigravityMessages.checking);
  });
  expect(checkAgain().hasAttribute("disabled")).toBe(true);
  settle({ state: "signed_out", version: "1.5.17" });
  await waitFor(() => {
    expect(statusLine()).toBe(antigravityMessages.stillSignedOut);
  });
  expect(checkAgain().hasAttribute("disabled")).toBe(false);

  // A check the native side could not answer says so, keeping the version.
  settle = holdNext();
  fireEvent.click(checkAgain());
  settle(new Error("refused"));
  await waitFor(() => {
    expect(statusLine()).toBe(antigravityMessages.checkFailed);
  });

  // Signed in from the CLI meanwhile: nothing is left to ask of the member,
  // so the row offers no button, like the other agents' signed-in rows.
  settle = holdNext();
  fireEvent.click(checkAgain());
  await waitFor(() => {
    expect(statusLine()).toBe(antigravityMessages.checking);
  });
  settle({ state: "signed_in", version: "1.5.17" });
  await waitFor(() => {
    expect(statusLine()).toBe(defaultMessages.agentSubscriptions.signedIn);
  });
  expect(
    queryByRole("button", { name: antigravityMessages.checkAgain }),
  ).toBeNull();

  const refreshes = calls.filter(
    ({ command, args }) =>
      command === "antigravity_get_status" &&
      typeof args === "object" &&
      args !== null &&
      Reflect.get(args, "refresh") === true,
  );
  expect(refreshes).toHaveLength(3);
});

test("every subscription row says its sign-in the same way and keeps one text edge", async () => {
  const email = "counsel.with.a.long.address@example-law-firm.test";
  const { findByText, getByText } = renderSection({
    harnesses: () =>
      statuses(
        { state: "ready", active: "0.164.0" },
        { state: "ready", active: "2.1.309" },
      ),
    chatGpt: () => ({
      state: "connected",
      email,
      plan: "plus",
      sessionStored: true,
      accounts: [],
    }),
    claudeCode: () => ({ state: "signed_in", email, plan: "pro" }),
    antigravity: () => ({ state: "signed_in", version: "1.5.17" }),
  });
  const signedInAs = message(defaultMessages.agentSubscriptions.signedInAs, {
    email,
  });
  const rows = await Promise.all(
    [
      defaultMessages.agentSubscriptions.chatGpt,
      defaultMessages.agentSubscriptions.claudeCode.title,
      antigravityMessages.title,
    ].map(async (title) => (await findByText(title)).closest("li")),
  );
  for (const row of rows) {
    // The mark sits in its own column, before the title.
    expect(
      row?.querySelector('[data-slot="list-item-media"] svg'),
    ).not.toBeNull();
    // The version line starts on the title's edge, past the mark.
    expect(row?.lastElementChild?.className).toContain("ps-15");
  }
  // Rows stella can sign out have a control; signed-in Antigravity, which
  // stella cannot sign out, asks nothing of the member.
  const [chatGptRow, claudeCodeRow, antigravityRow] = rows;
  for (const row of [chatGptRow, claudeCodeRow]) {
    expect(
      row?.querySelector('[data-slot="settings-row-control"]')?.textContent,
    ).not.toBe("");
  }
  expect(
    antigravityRow?.querySelector('[data-slot="settings-row-control"]'),
  ).toBeNull();
  // One line, cut short rather than wrapped when the email is long.
  const lines = await waitFor(() => {
    const found = [...document.querySelectorAll("span")].filter(
      (span) => span.textContent === signedInAs && span.children.length === 0,
    );
    expect(found).toHaveLength(2);
    return found;
  });
  for (const line of lines) {
    expect(line.className).toContain("truncate");
  }
  // The same verbs on every row that can sign out.
  const signOuts = [...document.querySelectorAll("button")].filter(
    (button) =>
      button.textContent === defaultMessages.agentSubscriptions.signOut,
  );
  expect(signOuts).toHaveLength(2);
  expect(getByText(defaultMessages.agentSubscriptions.signedIn)).toBeTruthy();
  for (const [name, version] of [
    ["Codex", "0.164.0"],
    ["Claude Code", "2.1.309"],
    [antigravityMessages.title, "1.5.17"],
  ] as const) {
    expect(getByText(message(install.ready, { name, version }))).toBeTruthy();
  }
});

test("shown again, a row starts from its last answer while a slow read runs", async () => {
  const email = "counsel@example-law-firm.test";
  const signedInAs = message(defaultMessages.agentSubscriptions.signedInAs, {
    email,
  });
  let claudeCodeAnswer: () => unknown = () => ({
    state: "signed_in",
    email,
    plan: "pro",
  });
  const calls: string[] = [];
  mockIPC(
    (command) => {
      calls.push(command);
      switch (command) {
        case "claude_code_auth_get_status":
          return claudeCodeAnswer();
        case "chatgpt_auth_get_status":
          return SIGNED_OUT_CHATGPT;
        case "harness_get_status":
          return statuses(
            { state: "ready", active: "0.164.0" },
            { state: "ready", active: "2.1.309" },
          );
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
  // Another settings page, then back: the section unmounts, the window not.
  const Window = () => {
    const [shown, setShown] = useState(true);
    return (
      <NativeStatusMemoryProvider>
        <button
          onClick={() => {
            setShown((now) => !now);
          }}
          type="button"
        >
          toggle page
        </button>
        {shown ? (
          <AgentSubscriptionsSection
            focus={null}
            onFocusShown={() => undefined}
            renderGroup={(content) => <section>{content}</section>}
          />
        ) : null}
      </NativeStatusMemoryProvider>
    );
  };
  const view = render(
    <DesktopIntlProvider language="en" messages={defaultMessages}>
      <Window />
    </DesktopIntlProvider>,
  );
  await view.findByText(signedInAs);
  fireEvent.click(view.getByRole("button", { name: "toggle page" }));
  expect(view.queryByText(signedInAs)).toBeNull();

  // The CLI is slow to answer this time: the row must not wait for it.
  const { promise: neverAnswers } = Promise.withResolvers<never>();
  claudeCodeAnswer = async () => neverAnswers;
  const readsBefore = calls.length;
  fireEvent.click(view.getByRole("button", { name: "toggle page" }));
  expect(view.getByText(signedInAs)).toBeTruthy();
  // It still asks again, so the remembered answer is replaced.
  await waitFor(() => {
    expect(
      calls.slice(readsBefore).includes("claude_code_auth_get_status"),
    ).toBe(true);
  });
});
