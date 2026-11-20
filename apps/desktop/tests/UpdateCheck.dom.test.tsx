import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost/" });

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
const { DesktopIntlProvider, defaultMessages } = await import("../src/i18n");
const { AppVersionRow } = await import("../src/mainview/UpdateCheck");

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

/** Tauri rejects `invoke` with the command's error string. */
const refuse = (message: string): never => {
  // oxlint-disable-next-line typescript/only-throw-error -- Tauri's rejection value is this string.
  throw message;
};

const messages = defaultMessages.settings.updates;
const SUPPORT_EMAIL = "support@example.test";
const SUPPORT_LINE = "Something feels wrong? Email our support:";

type Native = {
  check: () => unknown;
  install?: () => unknown;
};

const renderRow = ({ check, install = () => null }: Native) => {
  const commands: string[] = [];
  let emailed = 0;
  mockIPC((command) => {
    commands.push(command);
    switch (command) {
      case "check_for_updates":
        return check();
      case "install_update":
        return install();
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
  const view = render(
    <DesktopIntlProvider language="en" messages={defaultMessages}>
      <ul>
        <AppVersionRow
          onEmailSupport={() => {
            emailed += 1;
          }}
          supportEmail={SUPPORT_EMAIL}
          versionLabel="0.9.86"
        />
      </ul>
    </DesktopIntlProvider>,
  );
  const checkNow = async () => {
    fireEvent.click(
      view.getByRole("button", { name: defaultMessages.tray.checkForUpdates }),
    );
    await act(nextMacrotask);
  };
  return { ...view, checkNow, commands, emailed: () => emailed };
};

test("nothing but the button shows before a check", () => {
  const { getByRole, queryByText } = renderRow({
    check: () => ({ status: "up_to_date" }),
  });

  expect(
    getByRole("button", { name: defaultMessages.tray.checkForUpdates }),
  ).toBeDefined();
  expect(queryByText(SUPPORT_LINE, { exact: false })).toBeNull();
});

test("an up-to-date check says so with the support line", async () => {
  const view = renderRow({ check: () => ({ status: "up_to_date" }) });

  await view.checkNow();

  await waitFor(() => {
    expect(view.getByText(messages.upToDate)).toBeDefined();
  });
  expect(view.getByText(SUPPORT_LINE, { exact: false })).toBeDefined();
  expect(view.commands).toEqual(["check_for_updates"]);
});

test("the support address opens the mail app like the Email button", async () => {
  const view = renderRow({ check: () => ({ status: "up_to_date" }) });

  await view.checkNow();
  fireEvent.click(await view.findByRole("button", { name: SUPPORT_EMAIL }));

  expect(view.emailed()).toBe(1);
});

test("an available update is offered and installs through the updater", async () => {
  let installs = 0;
  const view = renderRow({
    check: () => ({ status: "available", version: "0.9.87" }),
    install: () => {
      installs += 1;
      return { status: "installing", version: "0.9.87" };
    },
  });

  await view.checkNow();
  expect(await view.findByText("Version 0.9.87 is available.")).toBeDefined();
  expect(installs).toBe(0);

  fireEvent.click(view.getByRole("button", { name: messages.install }));
  await act(nextMacrotask);

  expect(installs).toBe(1);
  expect(
    view.getByText(
      "Installing version 0.9.87. stella desktop restarts when it is done.",
    ),
  ).toBeDefined();
  expect(view.commands).toEqual(["check_for_updates", "install_update"]);

  // While installing, the check button stays reachable and says why it
  // cannot act; clicking it starts nothing.
  const checkButton = view.getByRole("button", {
    name: defaultMessages.tray.checkForUpdates,
  });
  expect(checkButton.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(checkButton);
  await act(nextMacrotask);
  expect(view.commands).toEqual(["check_for_updates", "install_update"]);
});

test("an install held for open documents says when it will happen", async () => {
  const view = renderRow({
    check: () => ({ status: "available", version: "0.9.87" }),
    install: () => ({ status: "deferred", version: "0.9.87" }),
  });

  await view.checkNow();
  fireEvent.click(await view.findByRole("button", { name: messages.install }));

  expect(
    await view.findByText(
      "Version 0.9.87 waits while documents are open for editing. When you finish, check again to install it, or it installs at the next automatic check.",
    ),
  ).toBeDefined();
});

test("a failed check is reported with the support line", async () => {
  const view = renderRow({ check: () => refuse("network unreachable") });

  await view.checkNow();

  expect((await view.findByRole("alert")).textContent).toBe(
    messages.checkFailed,
  );
  expect(view.getByText(SUPPORT_LINE, { exact: false })).toBeDefined();
});

test("a failed install is reported as an install failure", async () => {
  const view = renderRow({
    check: () => ({ status: "available", version: "0.9.87" }),
    install: () => refuse("signature mismatch"),
  });

  await view.checkNow();
  fireEvent.click(await view.findByRole("button", { name: messages.install }));

  expect((await view.findByRole("alert")).textContent).toBe(
    messages.installFailed,
  );
});

test("an answer the row does not know counts as a failed check", async () => {
  const view = renderRow({ check: () => ({ status: "available" }) });

  await view.checkNow();

  expect((await view.findByRole("alert")).textContent).toBe(
    messages.checkFailed,
  );
});

test("updates the organization manages are named as such", async () => {
  const view = renderRow({ check: () => ({ status: "managed" }) });

  await view.checkNow();

  expect(
    await view.findByText(defaultMessages.tray.updatesManaged),
  ).toBeDefined();
});
