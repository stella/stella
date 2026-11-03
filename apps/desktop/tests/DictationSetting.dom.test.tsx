import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost/" });

const { act, cleanup, render } = await import("@testing-library/react");
const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
const { DesktopIntlProvider, defaultMessages } = await import("../src/i18n");
const { DictationSetting } = await import("../src/mainview/DictationSetting");

afterEach(() => {
  cleanup();
  clearMocks();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const ENABLED_SNAPSHOT = {
  available: true,
  enabled: true,
  failure: null,
  keys: { code: "Space", modifiers: ["control", "alt"] },
  model: { status: "ready" },
  modelBytes: 740_363_168,
  phase: "idle",
  shortcutTaken: false,
};

/** Renders the setting over a native side that answers with `snapshot`. */
const renderSetting = async (snapshot: unknown) => {
  mockIPC((command) => {
    if (command === "dictation_get_snapshot") {
      return snapshot;
    }
    return undefined;
  });
  const view = render(
    <DesktopIntlProvider language="en" messages={defaultMessages}>
      <DictationSetting
        renderGroup={(content) => <section>{content}</section>}
      />
    </DesktopIntlProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return view;
};

test.each([
  ["without the feature", { available: false }],
  ["from a native side that has no answer", undefined],
  ["from a native side that sends something else", { status: "unknown" }],
])("shows no group at all %s", async (_case, snapshot) => {
  const { container } = await renderSetting(snapshot);

  expect(container.querySelector("section")).toBeNull();
});

test("shows the setting to an enrolled account", async () => {
  const { getByText } = await renderSetting(ENABLED_SNAPSHOT);

  expect(getByText(defaultMessages.dictation.title)).toBeTruthy();
  expect(getByText(defaultMessages.dictation.modelAttribution)).toBeTruthy();
});

test("offers the model download until it is installed", async () => {
  const { getByRole } = await renderSetting({
    ...ENABLED_SNAPSHOT,
    model: { status: "missing" },
  });

  expect(getByRole("button").textContent).toContain("740");
});

test("reports a failed dictation", async () => {
  const { getByRole } = await renderSetting({
    ...ENABLED_SNAPSHOT,
    failure: "microphone",
  });

  expect(getByRole("status").textContent).toBe(
    defaultMessages.dictation.failure.microphone,
  );
});
