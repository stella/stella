import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost/" });

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
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
  cleanup: true,
  enabled: true,
  language: {
    choice: "auto",
    inferred: ["cs", "en"],
    supported: ["cs", "en", "sk"],
  },
  failure: null,
  keys: { code: "Space", modifiers: ["control", "alt"] },
  model: { status: "ready" },
  modelBytes: 740_363_168,
  phase: "idle",
  shortcutTaken: false,
};

/** Renders the setting over a native side that answers with `snapshot`. */
const renderSetting = async (
  snapshot: unknown,
  onCommand: (command: string, payload: unknown) => unknown = () => undefined,
) => {
  mockIPC((command, payload) => {
    if (command === "dictation_get_snapshot") {
      return snapshot;
    }
    return onCommand(command, payload);
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

test("offers AI cleanup, on by default, with a truthful description", async () => {
  const { getByRole, getByText } = await renderSetting(ENABLED_SNAPSHOT);

  const toggle = getByRole("switch", {
    name: defaultMessages.dictation.cleanup.title,
  });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  const description = getByText(defaultMessages.dictation.cleanup.description);
  expect(description.textContent).toContain("audio never leaves it");
  expect(description.textContent).toContain(
    "through stella to your organization’s AI provider",
  );
  expect(description.textContent).not.toContain("stella AI");
});

test("the dictation description says where text goes while cleanup is on", async () => {
  const { container } = await renderSetting(ENABLED_SNAPSHOT);

  const description = container.querySelector("#dictation-description");
  expect(description?.textContent).toContain("transcribed on this computer");
  expect(description?.textContent).toContain(
    "the transcribed text, not the audio, is sent through stella to your organization’s AI provider",
  );
  expect(description?.textContent).toContain("stella does not store it");
});

test("turning cleanup off asks the native side and shows its answer", async () => {
  const calls: unknown[] = [];
  const { getByRole } = await renderSetting(
    ENABLED_SNAPSHOT,
    (command, payload) => {
      if (command !== "dictation_set_cleanup") {
        return undefined;
      }
      calls.push(payload);
      return { ...ENABLED_SNAPSHOT, cleanup: false };
    },
  );
  const toggle = getByRole("switch", {
    name: defaultMessages.dictation.cleanup.title,
  });

  fireEvent.click(toggle);

  await waitFor(() => {
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
  expect(calls).toEqual([{ enabled: false }]);
});

test("hides the cleanup switch while dictation is off", async () => {
  const { queryByText } = await renderSetting({
    ...ENABLED_SNAPSHOT,
    enabled: false,
  });

  expect(queryByText(defaultMessages.dictation.cleanup.title)).toBeNull();
});

test("explains a dictation that focus moved away from", async () => {
  const { getByRole } = await renderSetting({
    ...ENABLED_SNAPSHOT,
    failure: "focusChanged",
  });

  expect(getByRole("status").textContent).toBe(
    defaultMessages.dictation.failure.focusChanged,
  );
});

test.each(["focusUnconfirmed", "shortcutHeld"] as const)(
  "explains a dictation that typed nothing because of %s",
  async (failure) => {
    const { getByRole } = await renderSetting({
      ...ENABLED_SNAPSHOT,
      failure,
    });

    expect(getByRole("status").textContent).toBe(
      defaultMessages.dictation.failure[failure],
    );
  },
);

test("an unread focus is not reported as switching apps", () => {
  expect(defaultMessages.dictation.failure.focusUnconfirmed).not.toBe(
    defaultMessages.dictation.failure.focusChanged,
  );
  expect(defaultMessages.dictation.failure.focusUnconfirmed).not.toContain(
    "switched",
  );
});

test.each([
  ["cleanup is on", { cleanup: true, model: { status: "missing" } }, true],
  ["the installed model takes a language hint", { cleanup: false }, true],
  [
    "cleanup is off and no model is installed",
    { cleanup: false, model: { status: "missing" } },
    false,
  ],
  [
    "cleanup is off and the model lists no languages",
    {
      cleanup: false,
      language: { choice: "auto", inferred: [], supported: [] },
    },
    false,
  ],
])(
  "the dictation language row shows only when it has an effect: %s",
  async (_case, overrides, shown) => {
    const { container } = await renderSetting({
      ...ENABLED_SNAPSHOT,
      ...overrides,
    });

    expect(container.querySelector("#dictation-language") !== null).toBe(shown);
  },
);

test("automatic dictation language names the languages of this computer", async () => {
  const { container } = await renderSetting(ENABLED_SNAPSHOT);

  const input = container.querySelector<HTMLInputElement>(
    "#dictation-language",
  );
  expect(input?.value).toBe("Automatic (Čeština and English)");
});

test("a chosen dictation language is shown in its own name", async () => {
  const { container } = await renderSetting({
    ...ENABLED_SNAPSHOT,
    language: { ...ENABLED_SNAPSHOT.language, choice: "sk" },
  });

  const input = container.querySelector<HTMLInputElement>(
    "#dictation-language",
  );
  expect(input?.value).toBe("Slovenčina");
});
