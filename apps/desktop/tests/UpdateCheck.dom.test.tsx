import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { UpdaterSnapshot } from "@stll/api-contract/desktop-rpc";

GlobalRegistrator.register({ url: "http://localhost/" });

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { emit } = await import("@tauri-apps/api/event");
const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
const { DesktopIntlProvider, defaultMessages } = await import("../src/i18n");
const { AppVersionRow, UPDATER_STATE_EVENT, useUpdateCheck } =
  await import("../src/mainview/UpdateCheck");

/** One macrotask, for the mocked IPC promises and React's scheduler. */
const nextMacrotask = async () =>
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

afterEach(async () => {
  await act(nextMacrotask);
  cleanup();
  clearMocks();
});

afterAll(async () => {
  await nextMacrotask();
  await GlobalRegistrator.unregister();
});

const messages = defaultMessages.settings.updates;
const SUPPORT_EMAIL = "support@example.test";
const SUPPORT_LINE = "Something feels wrong? Email our support:";
const IDLE = {
  revision: 1,
  state: { status: "idle" },
} satisfies UpdaterSnapshot;
const DOWNLOADING =
  "Downloading version 0.9.90. stella desktop restarts once it is installed.";

/** What the native updater answers; `state` is what it is doing on mount. */
type Native = {
  state?: () => unknown;
  check?: () => unknown;
  install?: () => unknown;
};

const CheckedRow = ({ onEmailSupport }: { onEmailSupport: () => void }) => (
  <AppVersionRow
    onEmailSupport={onEmailSupport}
    supportEmail={SUPPORT_EMAIL}
    updateCheck={useUpdateCheck()}
    versionLabel="0.9.86"
  />
);

const renderRow = async ({
  state = () => IDLE,
  check = () => IDLE,
  install = () => IDLE,
}: Native) => {
  const commands: string[] = [];
  let emailed = 0;
  mockIPC(
    (command) => {
      commands.push(command);
      switch (command) {
        case "updater_state":
          return state();
        case "check_for_updates":
          return check();
        case "install_update":
          return install();
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
  const view = render(
    <DesktopIntlProvider language="en" messages={defaultMessages}>
      <ul>
        <CheckedRow
          onEmailSupport={() => {
            emailed += 1;
          }}
        />
      </ul>
    </DesktopIntlProvider>,
  );
  await waitFor(() => {
    expect(commands).toContain("updater_state");
  });
  await act(nextMacrotask);
  const checkButton = () =>
    view.getByRole("button", { name: defaultMessages.tray.checkForUpdates });
  const checkNow = async () => {
    fireEvent.click(checkButton());
    await act(nextMacrotask);
  };
  const announce = async (snapshot: UpdaterSnapshot) => {
    await act(async () => {
      await emit(UPDATER_STATE_EVENT, snapshot);
    });
  };
  return {
    ...view,
    announce,
    checkButton,
    checkNow,
    commands,
    emailed: () => emailed,
  };
};

const downloading = (
  revision: number,
  receivedBytes: number,
  totalBytes: number | null,
) =>
  ({
    revision,
    state: {
      status: "downloading",
      version: "0.9.90",
      receivedBytes,
      totalBytes,
    },
  }) satisfies UpdaterSnapshot;

test("nothing but the button shows while the updater is idle", async () => {
  const { checkButton, queryByText } = await renderRow({});

  expect(checkButton()).toBeDefined();
  expect(queryByText(SUPPORT_LINE, { exact: false })).toBeNull();
});

test("opened mid-install, the row shows the download and its progress", async () => {
  const view = await renderRow({ state: () => downloading(7, 50, 200) });

  expect(await view.findByText(DOWNLOADING)).toBeDefined();
  expect(view.getByText("25% downloaded")).toBeDefined();

  // Neither a check nor an install can start while it runs, whoever started
  // it; the button stays reachable and says why.
  const checkButton = view.getByRole("button", {
    name: defaultMessages.tray.checkForUpdates,
    description: messages.installInProgress,
  });
  expect(checkButton.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(checkButton);
  await act(nextMacrotask);
  expect(view.commands).toEqual(["updater_state"]);
});

test("an install started elsewhere follows the updater's announcements", async () => {
  const view = await renderRow({});

  await view.announce(downloading(2, 10, null));
  expect(view.getByText(DOWNLOADING)).toBeDefined();
  // The size is not known yet, so no share is named.
  expect(view.queryByText("downloaded", { exact: false })).toBeNull();

  await view.announce(downloading(3, 150, 200));
  expect(view.getByText("75% downloaded")).toBeDefined();

  await view.announce({
    revision: 4,
    state: { status: "installing", version: "0.9.90" },
  });
  const installing =
    "Installing version 0.9.90. stella desktop restarts when it is done.";
  expect(view.getByText(installing)).toBeDefined();

  // An announcement older than the one shown changes nothing.
  await view.announce({ revision: 3, state: { status: "up_to_date" } });
  expect(view.getByText(installing)).toBeDefined();
  expect(view.queryByText(messages.upToDate)).toBeNull();
});

test("an up-to-date check says so with the support line", async () => {
  const view = await renderRow({
    check: () => ({ revision: 2, state: { status: "up_to_date" } }),
  });

  await view.checkNow();

  await waitFor(() => {
    expect(view.getByText(messages.upToDate)).toBeDefined();
  });
  expect(view.getByText(SUPPORT_LINE, { exact: false })).toBeDefined();
  expect(view.commands).toEqual(["updater_state", "check_for_updates"]);
});

test("the support address opens the mail app like the Email button", async () => {
  const view = await renderRow({
    check: () => ({ revision: 2, state: { status: "up_to_date" } }),
  });

  await view.checkNow();
  fireEvent.click(await view.findByRole("button", { name: SUPPORT_EMAIL }));

  expect(view.emailed()).toBe(1);
});

test("an available update is offered and installs through the updater", async () => {
  let installs = 0;
  const view = await renderRow({
    check: () => ({
      revision: 2,
      state: { status: "available", version: "0.9.90" },
    }),
    install: () => {
      installs += 1;
      return {
        revision: 9,
        state: { status: "installing", version: "0.9.90" },
      };
    },
  });

  await view.checkNow();
  expect(await view.findByText("Version 0.9.90 is available.")).toBeDefined();
  expect(installs).toBe(0);

  fireEvent.click(view.getByRole("button", { name: messages.install }));
  await act(nextMacrotask);

  expect(installs).toBe(1);
  expect(
    view.getByText(
      "Installing version 0.9.90. stella desktop restarts when it is done.",
    ),
  ).toBeDefined();
  expect(view.commands).toEqual([
    "updater_state",
    "check_for_updates",
    "install_update",
  ]);
});

test("an install held for open documents says when it will happen", async () => {
  const view = await renderRow({
    check: () => ({
      revision: 2,
      state: { status: "available", version: "0.9.90" },
    }),
    install: () => ({
      revision: 4,
      state: { status: "deferred", version: "0.9.90" },
    }),
  });

  await view.checkNow();
  fireEvent.click(await view.findByRole("button", { name: messages.install }));

  expect(
    await view.findByText(
      "Version 0.9.90 waits while documents are open for editing. When you finish, check again to install it, or it installs at the next automatic check.",
    ),
  ).toBeDefined();
});

test("a failed check and a failed install are told apart", async () => {
  const view = await renderRow({
    check: () => ({
      revision: 2,
      state: { status: "failed", during: "check" },
    }),
  });

  await view.checkNow();
  expect((await view.findByRole("alert")).textContent).toBe(
    messages.checkFailed,
  );
  expect(view.getByText(SUPPORT_LINE, { exact: false })).toBeDefined();

  await view.announce({
    revision: 3,
    state: { status: "failed", during: "install" },
  });
  expect(view.getByRole("alert").textContent).toBe(messages.installFailed);
});

test("an answer the row does not know is reported, not shown", async () => {
  const view = await renderRow({
    check: () => ({ revision: 2, state: { status: "available" } }),
  });

  await view.checkNow();

  await waitFor(() => {
    expect(view.commands).toContain("desktop_report_error");
  });
  expect(view.queryByText(SUPPORT_LINE, { exact: false })).toBeNull();
});

test("updates the organization manages are named as such", async () => {
  const view = await renderRow({
    state: () => ({ revision: 1, state: { status: "managed" } }),
  });

  expect(
    await view.findByText(defaultMessages.tray.updatesManaged),
  ).toBeDefined();
});
