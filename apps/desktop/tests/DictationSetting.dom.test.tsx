import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost/" });

const { act, cleanup, fireEvent, render, waitFor, within } =
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
  cloudAvailable: false,
  cloudModel: null,
  destination: "local",
  enabled: true,
  keepsInHistory: true,
  language: {
    choice: "auto",
    inferred: ["cs", "en"],
    supported: ["cs", "en", "sk"],
  },
  shareWindowTitle: false,
  shareTextBeforeCursor: false,
  textBeforeCursorAvailable: true,
  failure: null,
  failureKeptInHistory: false,
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

test("a dictation that typed nothing says its text is in clipboard history", async () => {
  const { getByRole } = await renderSetting({
    ...ENABLED_SNAPSHOT,
    failure: "focusChanged",
    failureKeptInHistory: true,
  });

  expect(getByRole("status").textContent).toBe(
    `${defaultMessages.dictation.failure.focusChanged} ${defaultMessages.dictation.failureKeptInHistory}`,
  );
});

test("a failure whose text was not kept never promises clipboard history", async () => {
  const { getByRole } = await renderSetting({
    ...ENABLED_SNAPSHOT,
    keepsInHistory: false,
    failure: "shortcutHeld",
    failureKeptInHistory: false,
  });

  expect(getByRole("status").textContent).not.toContain(
    defaultMessages.dictation.failureKeptInHistory,
  );
});

test("says dictations are kept in clipboard history only while it keeps them", async () => {
  const kept = await renderSetting(ENABLED_SNAPSHOT);
  expect(
    kept.queryByText(defaultMessages.dictation.keptInHistory),
  ).not.toBeNull();
  kept.unmount();
  clearMocks();

  const off = await renderSetting({
    ...ENABLED_SNAPSHOT,
    keepsInHistory: false,
  });
  expect(off.queryByText(defaultMessages.dictation.keptInHistory)).toBeNull();
});

const THROUGH_STELLA = "through stella to your organization’s AI provider";

test("offers the context switches under cleanup, off by default, with what they send", async () => {
  const { getByRole, getByText } = await renderSetting(ENABLED_SNAPSHOT);
  const { windowTitle, textBeforeCursor } = defaultMessages.dictation.context;

  for (const title of [windowTitle.title, textBeforeCursor.title]) {
    const toggle = getByRole("switch", { name: title });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  }
  const titleCopy = getByText(windowTitle.description).textContent;
  expect(titleCopy).toContain("client or matter names");
  expect(titleCopy).toContain(THROUGH_STELLA);
  expect(titleCopy).toContain("stella does not store it");
  const textCopy = getByText(/characters before the cursor/u).textContent;
  expect(textCopy).toContain("1,000 characters");
  expect(textCopy).toContain("part of the document you are in");
  expect(textCopy).toContain(THROUGH_STELLA);
  expect(textCopy).toContain("stella does not store it");
});

test("hides the context switches while cleanup is off", async () => {
  const { queryByRole } = await renderSetting({
    ...ENABLED_SNAPSHOT,
    cleanup: false,
  });
  const { windowTitle, textBeforeCursor } = defaultMessages.dictation.context;

  expect(queryByRole("switch", { name: windowTitle.title })).toBeNull();
  expect(queryByRole("switch", { name: textBeforeCursor.title })).toBeNull();
});

test("offers no text-before-cursor switch where this computer cannot read it", async () => {
  const { queryByRole, getByRole } = await renderSetting({
    ...ENABLED_SNAPSHOT,
    textBeforeCursorAvailable: false,
  });
  const { windowTitle, textBeforeCursor } = defaultMessages.dictation.context;

  expect(getByRole("switch", { name: windowTitle.title })).toBeTruthy();
  expect(queryByRole("switch", { name: textBeforeCursor.title })).toBeNull();
});

test.each([
  ["dictation_set_share_window_title", "windowTitle", "shareWindowTitle"],
  [
    "dictation_set_share_text_before_cursor",
    "textBeforeCursor",
    "shareTextBeforeCursor",
  ],
] as const)(
  "turning on %s asks the native side and shows its answer",
  async (command, copy, field) => {
    const calls: unknown[] = [];
    const { getByRole } = await renderSetting(
      ENABLED_SNAPSHOT,
      (called, payload) => {
        if (called !== command) {
          return undefined;
        }
        calls.push(payload);
        return { ...ENABLED_SNAPSHOT, [field]: true };
      },
    );
    const toggle = getByRole("switch", {
      name: defaultMessages.dictation.context[copy].title,
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    });
    expect(calls).toEqual([{ enabled: true }]);
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

const CLOUD_MODELS = {
  defaultModelId: "mistralai/voxtral-mini-transcribe",
  models: [
    {
      displayName: "Voxtral Mini Transcribe",
      id: "mistralai/voxtral-mini-transcribe",
    },
  ],
  unavailable: null,
};

/** Opens the select labelled `name` and returns its list of options. */
const openSelect = async (
  view: Awaited<ReturnType<typeof renderSetting>>,
  name: string,
) => {
  const trigger = view.getByRole("combobox", { name });
  await act(async () => {
    fireEvent.click(trigger);
  });
  // Closed lists may stay mounted; the open one is the trigger's.
  return await waitFor(() => {
    const popup = view
      .getAllByRole("listbox")
      .find(({ id }) => id === trigger.getAttribute("aria-controls"));
    if (popup === undefined) {
      throw new TypeError(`The ${name} list did not open`);
    }
    return popup;
  });
};

test("stella AI transcription names the region's model and says audio leaves the computer", async () => {
  const { getByText, queryByRole } = await renderSetting(
    {
      ...ENABLED_SNAPSHOT,
      cloudAvailable: true,
      destination: "cloud",
      model: { status: "missing" },
    },
    (command) =>
      command === "dictation_get_cloud_models" ? CLOUD_MODELS : undefined,
  );
  await waitFor(() => {
    expect(getByText("Voxtral Mini Transcribe")).toBeTruthy();
  });
  expect(
    getByText(defaultMessages.dictation.destination.cloudDescription),
  ).toBeTruthy();
  expect(
    getByText(defaultMessages.dictation.cleanup.descriptionCloud),
  ).toBeTruthy();
  // The speech model download is not needed for stella AI.
  expect(queryByRole("button", { name: /Download/u })).toBeNull();
});

test("a region without a transcription model says so", async () => {
  const { getByRole } = await renderSetting(
    { ...ENABLED_SNAPSHOT, cloudAvailable: true },
    (command) =>
      command === "dictation_get_cloud_models"
        ? { defaultModelId: null, models: [], unavailable: "region" }
        : undefined,
  );
  await waitFor(() => {
    expect(getByRole("note").textContent).toBe(
      defaultMessages.dictation.destination.unavailableRegion,
    );
  });
});

test("this computer keeps the local description and the model download", async () => {
  const view = await renderSetting(
    { ...ENABLED_SNAPSHOT, cloudAvailable: true, model: { status: "missing" } },
    (command) =>
      command === "dictation_get_cloud_models" ? CLOUD_MODELS : undefined,
  );
  const { getByRole, getByText, queryByRole } = view;
  const destinations = await openSelect(
    view,
    defaultMessages.dictation.destination.title,
  );
  // Once the region's models arrive, stella AI can be chosen.
  await waitFor(() => {
    expect(
      within(destinations)
        .getByRole("option", {
          name: defaultMessages.dictation.destination.cloud,
        })
        .getAttribute("aria-disabled"),
    ).not.toBe("true");
  });

  expect(queryByRole("note")).toBeNull();
  expect(getByRole("button", { name: /Download/u })).toBeTruthy();
  expect(getByText(defaultMessages.dictation.cleanup.description)).toBeTruthy();
});

test("without the stella AI decision no destination is offered and no models are asked for", async () => {
  const commands: string[] = [];
  const { queryByText } = await renderSetting(
    { ...ENABLED_SNAPSHOT, model: { status: "missing" } },
    (command) => {
      commands.push(command);
      return command === "dictation_get_cloud_models"
        ? CLOUD_MODELS
        : undefined;
    },
  );

  expect(queryByText(defaultMessages.dictation.destination.title)).toBeNull();
  expect(commands).not.toContain("dictation_get_cloud_models");
});

test("picking the shown model stores it when the stored one is no longer offered", async () => {
  const stored: unknown[] = [];
  const snapshot = {
    ...ENABLED_SNAPSHOT,
    cloudAvailable: true,
    cloudModel: "retired/transcribe",
    destination: "cloud",
  };
  const view = await renderSetting(snapshot, (command, payload) => {
    if (command === "dictation_get_cloud_models") {
      return CLOUD_MODELS;
    }
    if (command === "dictation_set_cloud_model") {
      stored.push(payload);
      // The native side answers with the snapshot that now holds the pick.
      return { ...snapshot, cloudModel: "mistralai/voxtral-mini-transcribe" };
    }
    return undefined;
  });
  await waitFor(() => {
    expect(
      view.getByRole("combobox", {
        name: defaultMessages.dictation.destination.model,
      }).textContent,
    ).toContain("Voxtral Mini Transcribe");
  });
  const listbox = await openSelect(
    view,
    defaultMessages.dictation.destination.model,
  );
  const shown = within(listbox).getByRole("option", {
    name: "Voxtral Mini Transcribe",
  });
  await act(async () => {
    fireEvent.pointerDown(shown, { pointerType: "mouse" });
    fireEvent.click(shown);
  });

  await waitFor(() => {
    expect(stored).toEqual([{ modelId: "mistralai/voxtral-mini-transcribe" }]);
  });
  // The stored pick stays shown.
  expect(
    view.getByRole("combobox", {
      name: defaultMessages.dictation.destination.model,
    }).textContent,
  ).toContain("Voxtral Mini Transcribe");
});
