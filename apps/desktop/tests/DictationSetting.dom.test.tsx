import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost/" });

const { act, cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
const { emit } = await import("@tauri-apps/api/event");
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
  appSettings: [],
  available: true,
  cleanup: true,
  cloudAvailable: false,
  cloudModel: null,
  customWords: [],
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
  sounds: true,
  speakersOnly: true,
  textBeforeCursorAvailable: true,
  failure: null,
  failureKeptInHistory: false,
  holdKey: "combination",
  holdKeys: ["combination"],
  holdKeyWaiting: false,
  keys: { code: "Space", modifiers: ["control", "alt"] },
  model: { status: "ready" },
  modelBytes: 740_363_168,
  phase: "idle",
  recentApps: [],
  retypeKeys: { code: "KeyV", modifiers: ["control", "alt", "shift"] },
  retypeShortcut: true,
  retypeShortcutTaken: false,
  shortcutTaken: false,
  whileDictating: "nothing",
  whileDictatingOffered: ["nothing", "lower", "pause"],
};

/** Renders the setting over a native side that answers with `snapshot`. */
const renderSetting = async (
  snapshot: unknown,
  onCommand: (command: string, payload: unknown) => unknown = () => undefined,
) => {
  mockIPC((command, payload) => {
    const answered = onCommand(command, payload);
    // A test may answer the snapshot read itself, to change it between reads.
    if (command === "dictation_get_snapshot") {
      return answered ?? snapshot;
    }
    return answered;
  });
  const view = render(
    <DesktopIntlProvider language="en" messages={defaultMessages}>
      <DictationSetting />
    </DesktopIntlProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return view;
};

test("shows nothing at all without the feature", async () => {
  const { container } = await renderSetting({ available: false });

  expect(container.innerHTML).toBe("");
});

test.each([
  ["has no answer", undefined],
  ["sends something else", { status: "unknown" }],
])(
  "a native side that %s is reported with a way to read again",
  async (_case, answer) => {
    let reply: unknown = answer;
    const { findByRole, getByRole } = await renderSetting(
      undefined,
      (command) => (command === "dictation_get_snapshot" ? reply : undefined),
    );
    expect((await findByRole("alert")).textContent).toBe(
      defaultMessages.settings.errorReadState,
    );

    reply = ENABLED_SNAPSHOT;
    await act(async () => {
      fireEvent.click(
        getByRole("button", { name: defaultMessages.settings.tryAgain }),
      );
    });

    expect(
      await findByRole("switch", { name: defaultMessages.dictation.title }),
    ).toBeTruthy();
  },
);

test("shows the page to an enrolled account, with the switch in its header", async () => {
  const { getByRole } = await renderSetting(ENABLED_SNAPSHOT);

  const heading = getByRole("heading", {
    level: 1,
    name: defaultMessages.dictation.title,
  });
  expect(
    within(heading.closest("header") ?? document.body)
      .getByRole("switch", { name: defaultMessages.dictation.title })
      .getAttribute("aria-checked"),
  ).toBe("true");
  // The header names the key to hold as a key cap.
  expect(
    heading.closest("header")?.querySelector("kbd")?.textContent,
  ).toContain("Space");
});

test("the speech model's licence stays one focus away", async () => {
  const { getByRole, findByText } = await renderSetting(ENABLED_SNAPSHOT);

  const title = getByRole("button", {
    name: defaultMessages.dictation.speechModel,
  });
  await act(async () => {
    title.focus();
    fireEvent.focus(title);
  });

  expect(
    await findByText(defaultMessages.dictation.modelAttribution),
  ).toBeTruthy();
});

test("offers the model download until it is installed", async () => {
  const { getByRole } = await renderSetting({
    ...ENABLED_SNAPSHOT,
    model: { status: "missing" },
  });

  expect(getByRole("button", { name: /Download/u }).textContent).toContain(
    "740",
  );
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
  expect(description.textContent).toContain("not the audio");
  expect(description.textContent).toContain(
    "through stella to your organization’s AI provider",
  );
  expect(description.textContent).toContain("stella does not store it");
  expect(description.textContent).not.toContain("stella AI");
});

test("the transcription row says speech stays on this computer and leaves cleanup to its own row", async () => {
  const { container } = await renderSetting(ENABLED_SNAPSHOT);

  const description = container.querySelector(
    "#dictation-destination-description",
  );
  expect(description?.textContent).toContain("transcribed on this computer");
  expect(description?.textContent).toContain("is not stored");
  expect(description?.textContent).not.toContain("AI provider");
  expect(
    container.querySelector("#dictation-description")?.textContent,
  ).not.toContain("AI provider");
  // Where the text goes is said once, on the switch that sends it.
  expect(
    container.querySelector("#dictation-cleanup-description")?.textContent,
  ).toContain("through stella to your organization’s AI provider");
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

test("offers the context switches under cleanup, off by default, with what they send", async () => {
  const { getByRole, getByText } = await renderSetting(ENABLED_SNAPSHOT);
  const { windowTitle, textBeforeCursor } = defaultMessages.dictation.context;

  for (const title of [windowTitle.title, textBeforeCursor.title]) {
    const toggle = getByRole("switch", { name: title });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  }
  // Each says what it adds; where it goes is said once, by cleanup above.
  expect(getByText(windowTitle.description).textContent).toContain(
    "client or matter names",
  );
  const textCopy = getByText(
    /characters of the document you are in/u,
  ).textContent;
  expect(textCopy).toContain("1,000 characters");
});

test("the context switches stay under cleanup, disabled while it is off", async () => {
  const commands: string[] = [];
  const { getByRole } = await renderSetting(
    { ...ENABLED_SNAPSHOT, cleanup: false },
    (command) => {
      commands.push(command);
      return undefined;
    },
  );
  const { windowTitle, textBeforeCursor } = defaultMessages.dictation.context;

  for (const title of [windowTitle.title, textBeforeCursor.title]) {
    const toggle = getByRole("switch", { name: title });
    expect(toggle.dataset["disabled"] !== undefined).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(
      toggle.closest<HTMLElement>("[data-slot=settings-row]")?.dataset[
        "disabled"
      ],
    ).toBe("");
  }
  expect(
    commands.filter((command) => command.startsWith("dictation_set")),
  ).toEqual([]);
  // Cleanup itself stays switchable.
  expect(
    getByRole("switch", {
      name: defaultMessages.dictation.cleanup.title,
    }).dataset["disabled"],
  ).toBeUndefined();
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

test("turning the sounds off asks the native side and shows its answer", async () => {
  const calls: unknown[] = [];
  const { getByRole } = await renderSetting(
    ENABLED_SNAPSHOT,
    (called, payload) => {
      if (called !== "dictation_set_sounds") {
        return undefined;
      }
      calls.push(payload);
      return { ...ENABLED_SNAPSHOT, sounds: false };
    },
  );
  const toggle = getByRole("switch", {
    name: defaultMessages.dictation.sounds.title,
  });
  expect(toggle.getAttribute("aria-checked")).toBe("true");

  fireEvent.click(toggle);

  await waitFor(() => {
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
  expect(calls).toEqual([{ enabled: false }]);
});

test("turning the retype shortcut off asks the native side and shows its answer", async () => {
  const calls: unknown[] = [];
  const { getByRole } = await renderSetting(
    ENABLED_SNAPSHOT,
    (called, payload) => {
      if (called !== "dictation_set_retype_shortcut") {
        return undefined;
      }
      calls.push(payload);
      return { ...ENABLED_SNAPSHOT, retypeShortcut: false };
    },
  );
  const toggle = getByRole("switch", {
    name: defaultMessages.dictation.retype.title,
  });
  expect(toggle.getAttribute("aria-checked")).toBe("true");

  fireEvent.click(toggle);

  await waitFor(() => {
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
  expect(calls).toEqual([{ enabled: false }]);
});

test("a retype shortcut another app holds says so", async () => {
  const { findByText } = await renderSetting({
    ...ENABLED_SNAPSHOT,
    retypeShortcutTaken: true,
  });
  expect(await findByText(/^Another app is using /u)).toBeTruthy();
});

test("removing an app's own settings stores the rest", async () => {
  const calls: unknown[] = [];
  const code = {
    cleanup: "off",
    language: null,
    target: { kind: "code", type: "kind" },
  };
  const mail = {
    cleanup: null,
    language: "cs",
    target: { identifier: "com.apple.mail", name: "Mail", type: "app" },
  };
  const { getByRole } = await renderSetting(
    { ...ENABLED_SNAPSHOT, appSettings: [code, mail] },
    (called, payload) => {
      if (called !== "dictation_set_app_settings") {
        return undefined;
      }
      calls.push(payload);
      return { ...ENABLED_SNAPSHOT, appSettings: [mail] };
    },
  );

  fireEvent.click(
    getByRole("button", {
      name: `Remove ${defaultMessages.dictation.perApp.kinds.code}`,
    }),
  );

  await waitFor(() => {
    expect(calls).toEqual([{ settings: [mail] }]);
  });
});

test("speakers only is offered once dictation changes other sound", async () => {
  const calls: unknown[] = [];
  const { getByRole, queryByRole } = await renderSetting(
    { ...ENABLED_SNAPSHOT, whileDictating: "lower" },
    (called, payload) => {
      if (called !== "dictation_set_speakers_only") {
        return undefined;
      }
      calls.push(payload);
      return {
        ...ENABLED_SNAPSHOT,
        speakersOnly: false,
        whileDictating: "lower",
      };
    },
  );
  const toggle = getByRole("switch", {
    name: defaultMessages.dictation.whileDictating.speakersOnly.title,
  });
  expect(toggle.getAttribute("aria-checked")).toBe("true");

  fireEvent.click(toggle);

  await waitFor(() => {
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
  expect(calls).toEqual([{ enabled: false }]);
  cleanup();

  await renderSetting(ENABLED_SNAPSHOT);
  expect(
    queryByRole("switch", {
      name: defaultMessages.dictation.whileDictating.speakersOnly.title,
    }),
  ).toBeNull();
});

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
  const { local: thisComputer } = defaultMessages.dictation.destination;
  const destinations = getByRole("group", {
    name: defaultMessages.dictation.destination.title,
  });
  expect(
    within(destinations)
      .getByRole("button", {
        name: thisComputer,
      })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  // Once the region's models arrive, stella AI can be chosen.
  await waitFor(() => {
    expect(
      within(destinations).getByRole("button", {
        name: defaultMessages.dictation.destination.cloud,
      }).dataset["disabled"],
    ).toBeUndefined();
  });

  expect(queryByRole("note")).toBeNull();
  expect(getByRole("button", { name: /Download/u })).toBeTruthy();
  expect(getByText(defaultMessages.dictation.cleanup.description)).toBeTruthy();
});

test("choosing stella AI asks the native side to transcribe there", async () => {
  const calls: unknown[] = [];
  const view = await renderSetting(
    { ...ENABLED_SNAPSHOT, cloudAvailable: true, model: { status: "missing" } },
    (command, payload) => {
      if (command === "dictation_get_cloud_models") {
        return CLOUD_MODELS;
      }
      if (command === "dictation_set_destination") {
        calls.push(payload);
        return {
          ...ENABLED_SNAPSHOT,
          cloudAvailable: true,
          destination: "cloud",
        };
      }
      return undefined;
    },
  );
  const cloud = view.getByRole("button", {
    name: defaultMessages.dictation.destination.cloud,
  });
  await waitFor(() => {
    expect(cloud.dataset["disabled"] !== undefined).toBe(false);
  });

  await act(async () => {
    fireEvent.click(cloud);
  });

  await waitFor(() => {
    expect(calls).toEqual([{ destination: "cloud" }]);
  });
  await waitFor(() => {
    expect(cloud.getAttribute("aria-pressed")).toBe("true");
  });
});

test("without the stella AI decision only this computer is named and no models are asked for", async () => {
  const commands: string[] = [];
  const { getByText, queryByRole } = await renderSetting(
    { ...ENABLED_SNAPSHOT, model: { status: "missing" } },
    (command) => {
      commands.push(command);
      return command === "dictation_get_cloud_models"
        ? CLOUD_MODELS
        : undefined;
    },
  );

  expect(
    getByText(defaultMessages.dictation.destination.localDescription),
  ).toBeTruthy();
  expect(
    queryByRole("button", {
      name: defaultMessages.dictation.destination.cloud,
    }),
  ).toBeNull();
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

test("a model outside the organization's region is named with its provider and says so", async () => {
  const view = await renderSetting(
    {
      ...ENABLED_SNAPSHOT,
      cloudAvailable: true,
      cloudModel: "google/chirp-3",
      destination: "cloud",
    },
    (command) =>
      command === "dictation_get_cloud_models"
        ? {
            ...CLOUD_MODELS,
            models: [
              ...CLOUD_MODELS.models,
              {
                displayName: "Chirp 3",
                id: "google/chirp-3",
                outsideRegion: true,
                provider: "Google",
              },
            ],
          }
        : undefined,
  );
  const { destination } = defaultMessages.dictation;
  await waitFor(() => {
    expect(
      view.getByRole("combobox", { name: destination.model }).textContent,
    ).toBe("Chirp 3");
  });
  const tags = view.container.querySelector(
    "#dictation-cloud-model-description",
  );
  expect(tags?.textContent).toContain("Google");
  expect(tags?.textContent).toContain(destination.outsideRegion);
  expect(view.queryByRole("alert")).toBeNull();

  const models = await openSelect(view, destination.model);
  expect(
    within(models).getByRole("option", { name: "Voxtral Mini Transcribe" }),
  ).toBeTruthy();
});

test("a model whose provider keeps the audio is labeled and warned about when chosen", async () => {
  const view = await renderSetting(
    {
      ...ENABLED_SNAPSHOT,
      cloudAvailable: true,
      cloudModel: "elevenlabs-direct/scribe-v3",
      destination: "cloud",
    },
    (command) =>
      command === "dictation_get_cloud_models"
        ? {
            ...CLOUD_MODELS,
            models: [
              ...CLOUD_MODELS.models,
              {
                displayName: "Scribe v3",
                id: "elevenlabs-direct/scribe-v3",
                outsideRegion: false,
                provider: "ElevenLabs",
                retainsData: true,
              },
            ],
          }
        : undefined,
  );
  const { destination } = defaultMessages.dictation;
  await waitFor(() => {
    expect(
      view.getByRole("combobox", { name: destination.model }).textContent,
    ).toBe("Scribe v3");
  });
  expect(
    view.container.querySelector("#dictation-cloud-model-description")
      ?.textContent,
  ).toContain(destination.retainsData);
  const warning = view.getByRole("alert");
  expect(warning.textContent).toContain(
    destination.retainsDataTitle.replace("{provider}", "ElevenLabs"),
  );
  expect(warning.textContent).toContain(
    destination.retainsDataWarning.replace("{provider}", "ElevenLabs"),
  );
});

test("a model whose provider keeps the audio is never shown as the fallback", async () => {
  const view = await renderSetting(
    {
      ...ENABLED_SNAPSHOT,
      cloudAvailable: true,
      cloudModel: null,
      destination: "cloud",
    },
    (command) =>
      command === "dictation_get_cloud_models"
        ? {
            defaultModelId: null,
            models: [
              {
                displayName: "Scribe v3",
                id: "elevenlabs-direct/scribe-v3",
                outsideRegion: false,
                provider: "ElevenLabs",
                retainsData: true,
              },
            ],
            unavailable: null,
          }
        : undefined,
  );
  const { destination } = defaultMessages.dictation;
  await waitFor(() => {
    expect(view.getByText(destination.chooseModel)).toBeTruthy();
  });
  expect(view.queryByRole("alert")).toBeNull();
});

test("a model in the region adds no note", async () => {
  const { getByText, queryByRole, queryByText } = await renderSetting(
    { ...ENABLED_SNAPSHOT, cloudAvailable: true, destination: "cloud" },
    (command) =>
      command === "dictation_get_cloud_models" ? CLOUD_MODELS : undefined,
  );
  await waitFor(() => {
    expect(getByText("Voxtral Mini Transcribe")).toBeTruthy();
  });
  expect(
    queryByText(defaultMessages.dictation.destination.outsideRegion),
  ).toBeNull();
  expect(
    queryByText(defaultMessages.dictation.destination.retainsData),
  ).toBeNull();
  expect(queryByRole("alert")).toBeNull();
});

test("a downloaded speech model can be removed, also while stella AI transcribes", async () => {
  const commands: string[] = [];
  const { getByRole } = await renderSetting(
    { ...ENABLED_SNAPSHOT, destination: "cloud" },
    (command) => {
      commands.push(command);
      return command === "dictation_remove_model"
        ? {
            ...ENABLED_SNAPSHOT,
            destination: "cloud",
            model: { status: "missing" },
          }
        : undefined;
    },
  );

  fireEvent.click(
    getByRole("button", { name: defaultMessages.dictation.removeModel }),
  );

  await waitFor(() => {
    expect(commands).toContain("dictation_remove_model");
  });
  // Gone, and stella AI needs no download prompt in its place.
  await waitFor(() => {
    expect(
      document.body.textContent.includes(defaultMessages.dictation.removeModel),
    ).toBe(false);
  });
  expect(document.body.textContent).not.toContain(
    defaultMessages.dictation.modelNeeded,
  );
});

test("the model cannot be removed while a dictation runs", async () => {
  const { getByRole } = await renderSetting({
    ...ENABLED_SNAPSHOT,
    phase: "recording",
  });

  expect(
    getByRole("button", {
      name: defaultMessages.dictation.removeModel,
    }).getAttribute("aria-disabled"),
  ).toBe("true");
});

test("the retention warning shows only while the chosen model keeps the audio", async () => {
  const models = {
    ...CLOUD_MODELS,
    models: [
      ...CLOUD_MODELS.models,
      {
        displayName: "Scribe v3",
        id: "elevenlabs-direct/scribe-v3",
        outsideRegion: false,
        provider: "ElevenLabs",
        retainsData: true,
      },
    ],
  };
  const snapshot = {
    ...ENABLED_SNAPSHOT,
    cloudAvailable: true,
    cloudModel: "elevenlabs-direct/scribe-v3",
    destination: "cloud",
  };
  const view = await renderSetting(snapshot, (command) => {
    if (command === "dictation_get_cloud_models") {
      return models;
    }
    if (command === "dictation_set_cloud_model") {
      return { ...snapshot, cloudModel: "mistralai/voxtral-mini-transcribe" };
    }
    return undefined;
  });
  const { destination } = defaultMessages.dictation;
  await waitFor(() => {
    expect(view.getByRole("alert").textContent).toContain(
      destination.retainsDataTitle.replace("{provider}", "ElevenLabs"),
    );
  });

  const listbox = await openSelect(view, destination.model);
  const other = within(listbox).getByRole("option", {
    name: "Voxtral Mini Transcribe",
  });
  await act(async () => {
    fireEvent.pointerDown(other, { pointerType: "mouse" });
    fireEvent.click(other);
  });

  await waitFor(() => {
    expect(view.queryByRole("alert")).toBeNull();
  });
});

const HOLD_KEY_SNAPSHOT = {
  ...ENABLED_SNAPSHOT,
  holdKey: "fn",
  holdKeys: ["fn", "rightOption", "combination"],
};

test("the header names the key to hold", async () => {
  const { container } = await renderSetting(HOLD_KEY_SNAPSHOT);

  expect(
    container.querySelector("#dictation-description kbd")?.textContent,
  ).toBe("fn");
});

test("the speaker picks another key from what this computer offers", async () => {
  const picked: unknown[] = [];
  const view = await renderSetting(HOLD_KEY_SNAPSHOT, (command, payload) => {
    if (command === "dictation_set_hold_key") {
      picked.push(payload);
      return { ...HOLD_KEY_SNAPSHOT, holdKey: "rightOption" };
    }
    return undefined;
  });

  expect(
    view.getByRole("heading", {
      name: defaultMessages.dictation.groups.shortcut,
    }),
  ).toBeTruthy();
  const listbox = await openSelect(
    view,
    defaultMessages.dictation.holdKey.title,
  );
  const options = within(listbox).getAllByRole("option");
  expect(options).toHaveLength(3);
  const right = within(listbox).getByRole("option", { name: /^Right /u });
  await act(async () => {
    fireEvent.pointerDown(right, { pointerType: "mouse" });
    fireEvent.click(right);
  });

  await waitFor(() => {
    expect(picked).toEqual([{ holdKey: "rightOption" }]);
  });
});

test("a read that started before a new key was picked does not bring the old key back", async () => {
  let reads = 0;
  let answerLateRead: (() => void) | undefined;
  mockIPC(
    async (command) => {
      if (command === "dictation_get_snapshot") {
        reads += 1;
        if (reads === 2) {
          await new Promise<void>((resolve) => {
            answerLateRead = resolve;
          });
        }
        return HOLD_KEY_SNAPSHOT;
      }
      if (command === "dictation_set_hold_key") {
        return { ...HOLD_KEY_SNAPSHOT, holdKey: "rightOption" };
      }
      return undefined;
    },
    { shouldMockEvents: true },
  );
  const view = render(
    <DesktopIntlProvider language="en" messages={defaultMessages}>
      <DictationSetting />
    </DesktopIntlProvider>,
  );
  const trigger = await view.findByRole("combobox", {
    name: defaultMessages.dictation.holdKey.title,
  });
  expect(trigger.textContent).not.toMatch(/^Right /u);

  // A read starts with fn still chosen and answers only after the change.
  await act(async () => {
    await emit("dictation-changed");
  });
  await waitFor(() => {
    expect(answerLateRead).toBeDefined();
  });
  const listbox = await openSelect(
    view,
    defaultMessages.dictation.holdKey.title,
  );
  const right = within(listbox).getByRole("option", { name: /^Right /u });
  await act(async () => {
    fireEvent.pointerDown(right, { pointerType: "mouse" });
    fireEvent.click(right);
  });
  await waitFor(() => {
    expect(trigger.textContent).toMatch(/^Right /u);
  });

  await act(async () => {
    answerLateRead?.();
    await Promise.resolve();
  });

  expect(trigger.textContent).toMatch(/^Right /u);
});

test("a computer that offers one key shows no choice", async () => {
  const { queryByText } = await renderSetting(ENABLED_SNAPSHOT);

  expect(queryByText(defaultMessages.dictation.holdKey.title)).toBeNull();
  // The group stays for the microphone choice.
  expect(queryByText(defaultMessages.dictation.groups.shortcut)).not.toBeNull();
});

test("a key that cannot be heard yet says so", async () => {
  const { getByText } = await renderSetting({
    ...HOLD_KEY_SNAPSHOT,
    holdKeyWaiting: true,
  });

  const messages = [
    defaultMessages.dictation.holdKey.waiting,
    defaultMessages.dictation.holdKey.unavailable,
  ].map((message) => message.replace("{shortcut}", "fn"));
  expect(getByText((text) => messages.includes(text))).toBeTruthy();
});

test("a dictation refused in a password field says nothing was recorded", async () => {
  const { getByText } = await renderSetting({
    ...ENABLED_SNAPSHOT,
    failure: "passwordField",
  });

  expect(
    getByText(defaultMessages.dictation.failure.passwordField),
  ).toBeTruthy();
});

const customWords = defaultMessages.dictation.customWords;

const sentWords = (payload: unknown): string[] =>
  typeof payload === "object" &&
  payload !== null &&
  "words" in payload &&
  Array.isArray(payload.words)
    ? payload.words.filter((word): word is string => typeof word === "string")
    : [];

test("custom words are added and removed through the native side, which answers with the stored list", async () => {
  const calls: unknown[] = [];
  const { findByRole, getByRole } = await renderSetting(
    ENABLED_SNAPSHOT,
    (command, payload) => {
      if (command !== "dictation_set_custom_words") {
        return undefined;
      }
      calls.push(payload);
      return { ...ENABLED_SNAPSHOT, customWords: sentWords(payload) };
    },
  );
  const input = getByRole("textbox", { name: customWords.input });

  fireEvent.change(input, { target: { value: "  custom terms list " } });
  await act(async () => {
    fireEvent.click(getByRole("button", { name: customWords.add }));
  });

  const remove = await findByRole("button", {
    name: customWords.remove.replace("{word}", "custom terms list"),
  });
  expect(calls).toEqual([{ words: ["custom terms list"] }]);
  expect(input instanceof HTMLInputElement && input.value).toBe("");
  expect(input.getAttribute("maxlength")).toBe("100");

  await act(async () => {
    fireEvent.click(remove);
  });

  expect(calls.at(-1)).toEqual({ words: [] });
});

test("a custom word already listed, whatever its case, is not sent again", async () => {
  const calls: unknown[] = [];
  const { findByRole, getByRole } = await renderSetting(
    { ...ENABLED_SNAPSHOT, customWords: ["Libeňská"] },
    (command, payload) => {
      if (command === "dictation_set_custom_words") {
        calls.push(payload);
      }
      return undefined;
    },
  );

  fireEvent.change(getByRole("textbox", { name: customWords.input }), {
    target: { value: "libeňská" },
  });
  await act(async () => {
    fireEvent.click(getByRole("button", { name: customWords.add }));
  });

  expect((await findByRole("alert")).textContent).toBe(customWords.duplicate);
  expect(calls).toEqual([]);
});

test("a full list of custom words takes no more", async () => {
  const full = Array.from({ length: 100 }, (_unused, index) => `w${index}`);
  const { getByRole } = await renderSetting({
    ...ENABLED_SNAPSHOT,
    customWords: full,
  });

  fireEvent.change(getByRole("textbox", { name: customWords.input }), {
    target: { value: "one more" },
  });

  expect(
    getByRole("button", { name: customWords.add }).getAttribute(
      "aria-disabled",
    ),
  ).toBe("true");
});

test("custom words are offered with the speech model on this computer and cleanup off, which spell with them", async () => {
  const { queryByText } = await renderSetting({
    ...ENABLED_SNAPSHOT,
    cleanup: false,
    destination: "local",
  });

  expect(queryByText(customWords.title)).not.toBeNull();
});
