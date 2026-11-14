import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost/" });

const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { emit } = await import("@tauri-apps/api/event");
const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
const { ActivitySettingsPane } =
  await import("../src/activity/ActivitySettings");
const { ACTIVITY_CHANGED_EVENT } =
  await import("../src/activity/activity-types");
const { DesktopIntlProvider, defaultMessages } = await import("../src/i18n");

afterEach(() => {
  cleanup();
  clearMocks();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const messages = defaultMessages.activity;

const SETTINGS = {
  date: "2026-03-10",
  today: "2026-03-10",
  earliestDate: "2026-02-09",
  latestDate: "2026-03-10",
  deletionStatus: "available",
  persistence: "encrypted",
  retention: "month",
  excludedApps: [],
  otherAccountHistoryDays: 0,
  captureDetails: false,
  detectCalls: true,
  appNameOnlyApps: [],
  detailsAccess: "disabled",
  browserApps: [],
  browserTitleApps: [],
  apps: [],
  sourceAppVisuals: [],
};

/** Renders the pane over a native side whose reads follow `native`. */
const renderPane = async (native: { readable: boolean }) => {
  mockIPC(
    (command) => {
      if (command === "activity_get_settings") {
        if (!native.readable) {
          throw new Error("activity account unavailable");
        }
        return SETTINGS;
      }
      if (command === "activity_set_detect_calls") {
        throw new Error("rejected");
      }
      return null;
    },
    { shouldMockEvents: true },
  );
  const view = render(
    <DesktopIntlProvider language="en" messages={defaultMessages}>
      <ActivitySettingsPane />
    </DesktopIntlProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return view;
};

test("a read that succeeds clears the error an earlier read left", async () => {
  const native = { readable: false };
  const { findByRole, findByText, queryByText } = await renderPane(native);
  await findByText(messages.errorRead);

  native.readable = true;
  await act(async () => {
    await emit(ACTIVITY_CHANGED_EVENT);
  });

  await findByRole("checkbox", { name: messages.detectCalls });
  expect(queryByText(messages.errorRead)).toBeNull();
});

test("a read that succeeds leaves the error of a failed change in place", async () => {
  const { findByRole, findByText } = await renderPane({ readable: true });
  fireEvent.click(await findByRole("checkbox", { name: messages.detectCalls }));
  await findByText(messages.errorUpdate);

  await act(async () => {
    await emit(ACTIVITY_CHANGED_EVENT);
  });

  await findByText(messages.errorUpdate);
});
