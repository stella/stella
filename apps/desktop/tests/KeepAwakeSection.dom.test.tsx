import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { KeepAwakeSettings } from "../src/mainview/KeepAwakeSection";

GlobalRegistrator.register({ url: "http://localhost/" });

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
const { DesktopIntlProvider, defaultMessages } = await import("../src/i18n");
const { KeepAwakeSection } = await import("../src/mainview/KeepAwakeSection");

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
const refuse = (code: string): never => {
  // oxlint-disable-next-line typescript/only-throw-error -- Tauri's rejection value is this string, and the section reads it.
  throw code;
};

const messages = defaultMessages.keepAwake;

type Native = {
  get: () => unknown;
  /** What the save command answers; a thrown string is its error code. */
  set?: (settings: KeepAwakeSettings) => unknown;
};

/** The settings a save sends, as the native command reads them. */
const sentSettings = (args: unknown): KeepAwakeSettings => {
  if (
    typeof args === "object" &&
    args !== null &&
    "settings" in args &&
    typeof args.settings === "object" &&
    args.settings !== null &&
    "enabled" in args.settings &&
    typeof args.settings.enabled === "boolean" &&
    "onBattery" in args.settings &&
    typeof args.settings.onBattery === "boolean"
  ) {
    return {
      enabled: args.settings.enabled,
      onBattery: args.settings.onBattery,
    };
  }
  throw new Error("a save sent no settings");
};

const renderSection = ({ get, set = (settings) => settings }: Native) => {
  const calls: { command: string; args: unknown }[] = [];
  let stored = get;
  mockIPC(
    (command, args) => {
      calls.push({ command, args });
      switch (command) {
        case "keep_awake_get_settings":
          return stored();
        case "keep_awake_set_settings": {
          const saved = set(sentSettings(args));
          stored = () => saved;
          return saved;
        }
        default:
          throw new Error(`unexpected command ${command}`);
      }
    },
    { shouldMockEvents: true },
  );
  const view = render(
    <DesktopIntlProvider language="en" messages={defaultMessages}>
      <KeepAwakeSection />
    </DesktopIntlProvider>,
  );
  return { ...view, calls };
};

const isChecked = (element: HTMLElement) =>
  element.getAttribute("aria-checked") === "true";

test("renders nothing when local agents are off for the account", async () => {
  const { container, calls } = renderSection({
    get: () => refuse("feature_disabled"),
  });
  await waitFor(() => {
    expect(
      calls.some(({ command }) => command === "keep_awake_get_settings"),
    ).toBe(true);
  });
  expect(container.textContent).toBe("");
});

test("shows the stored choice, and says a closed lid still sleeps the Mac", async () => {
  const { findByRole, getByText } = renderSection({
    get: () => ({ enabled: true, onBattery: false }),
  });
  const keepAwake = await findByRole("switch", { name: messages.enabled });
  const onBattery = await findByRole("switch", { name: messages.onBattery });

  expect(isChecked(keepAwake)).toBe(true);
  expect(isChecked(onBattery)).toBe(false);
  expect(getByText(messages.description).textContent).toContain("lid");
});

test("allowing battery power saves both switches together", async () => {
  const { calls, findByRole } = renderSection({
    get: () => ({ enabled: true, onBattery: false }),
  });
  fireEvent.click(await findByRole("switch", { name: messages.onBattery }));

  await waitFor(() => {
    expect(calls).toContainEqual({
      command: "keep_awake_set_settings",
      args: { settings: { enabled: true, onBattery: true } },
    });
  });
});

test("with keeping awake off, the battery switch cannot be changed", async () => {
  const { findByRole } = renderSection({
    get: () => ({ enabled: false, onBattery: false }),
  });
  const onBattery = await findByRole("switch", { name: messages.onBattery });
  expect(
    onBattery.hasAttribute("disabled") ||
      onBattery.getAttribute("aria-disabled") === "true" ||
      Object.hasOwn(onBattery.dataset, "disabled"),
  ).toBe(true);
});

test("a choice that could not be saved says so", async () => {
  const { findByRole, findByText } = renderSection({
    get: () => ({ enabled: true, onBattery: false }),
    set: () => refuse("unsaved"),
  });
  fireEvent.click(await findByRole("switch", { name: messages.enabled }));

  await findByText(messages.errorSave);
});
