import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost/" });

const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { emit } = await import("@tauri-apps/api/event");
const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
const { DesktopIntlProvider, defaultMessages } = await import("../src/i18n");
const { TryItStep } = await import("../src/onboarding/TryItStep");
const { CLIPBOARD_SHORTCUT_CHANGED_EVENT } =
  await import("../src/shared/shortcut-keys");

afterEach(() => {
  cleanup();
  clearMocks();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const messages = defaultMessages.onboarding;

const TRY_IT_STEP = {
  activityAvailable: false,
  activityPermissions: [],
  dictationAvailable: false,
  dictationPermissions: [],
  documentApp: null,
  linked: true,
  mode: { type: "tour" },
  step: "tryIt",
  steps: ["welcome", "howItWorks", "tryIt", "done"],
  trayLocation: null,
} as const;

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

test("a new shortcut starts the try without the previous key's hint", async () => {
  const native = {
    keys: { code: "KeyV", modifiers: ["control", "shift"] },
  };
  mockIPC(
    (command) =>
      command === "shortcut_get_snapshot"
        ? {
            defaultKeys: { code: "KeyV", modifiers: ["control", "shift"] },
            keys: native.keys,
            registration: "active",
          }
        : null,
    { shouldMockEvents: true },
  );
  const { findByText, queryByText } = render(
    <DesktopIntlProvider language="en" messages={defaultMessages}>
      <TryItStep
        onBack={() => undefined}
        onContinue={() => undefined}
        snapshot={TRY_IT_STEP}
      />
    </DesktopIntlProvider>,
  );
  await settle();
  fireEvent.focus(window);
  await findByText(messages.tryWaiting);

  // A key that is not the shortcut's names itself.
  fireEvent.keyDown(window, { code: "KeyQ", key: "q" });
  expect(queryByText(messages.tryWaiting)).toBeNull();

  native.keys = { code: "KeyB", modifiers: ["control", "alt"] };
  await act(async () => {
    await emit(CLIPBOARD_SHORTCUT_CHANGED_EVENT);
  });
  await settle();
  fireEvent.focus(window);

  await findByText(messages.tryWaiting);
});
