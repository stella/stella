import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { nextMacrotask } from "@stll/concurrency/event-loop";

// The platform is read from the user agent when the modules load.
GlobalRegistrator.register({
  settings: {
    navigator: {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
    },
  },
  url: "http://localhost/",
});

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { emit } = await import("@tauri-apps/api/event");
const { clearMocks } = await import("@tauri-apps/api/mocks");
const { DesktopIntlProvider, defaultMessages } = await import("../src/i18n");
const { default: OnboardingApp } =
  await import("../src/onboarding/OnboardingApp");
const {
  DICTATION_OFF,
  DICTATION_STEP,
  installNativeSide,
  nativeSide,
  sentCommands,
} = await import("./onboarding-dictation-native");

// React's scheduler and the mocked IPC answers run on a macrotask; each
// test and the file let one pass while the DOM is still registered.
afterEach(async () => {
  await act(nextMacrotask);
  cleanup();
  clearMocks();
});

afterAll(async () => {
  await nextMacrotask();
  await GlobalRegistrator.unregister();
});

const onboarding = defaultMessages.onboarding;
const setup = defaultMessages.onboarding.dictationSetup;
const dictation = defaultMessages.dictation;

const renderSetup = async (native: ReturnType<typeof nativeSide>) => {
  installNativeSide(native);
  const view = render(
    <DesktopIntlProvider language="en" messages={defaultMessages}>
      <OnboardingApp />
    </DesktopIntlProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return view;
};

type View = Awaited<ReturnType<typeof renderSetup>>;

/** Clicks Continue until `title` heads the step. */
const continueTo = async (view: View, title: string) => {
  for (let screen = 0; screen < 5; screen += 1) {
    if (view.queryByRole("heading", { level: 1, name: title }) !== null) {
      return;
    }
    fireEvent.click(
      await view.findByRole("button", { name: onboarding.continue }),
    );
    await act(nextMacrotask);
  }
  await view.findByRole("heading", { level: 1, name: title });
};

const DICTATION_ON = { ...DICTATION_OFF, enabled: true } as const;

test("the first screen names the macOS shortcut and asks for the microphone, then Accessibility", async () => {
  const { container, findByText, getByRole } = await renderSetup(nativeSide());

  await findByText(setup.microphone.bodyMac.replace("{shortcut}", "⌃⌥Space"));
  expect(getByRole("heading", { level: 1 }).textContent).toBe(
    setup.microphone.title,
  );
  await findByText(onboarding.dictationMicrophone);
  await findByText(onboarding.dictationAccessibility);
  const text = container.textContent;
  expect(text.indexOf(onboarding.dictationMicrophone)).toBeLessThan(
    text.indexOf(onboarding.dictationAccessibility),
  );
  // The screens in the footer's dots, in order, with the first one current.
  const steps = [...container.querySelectorAll("[data-slot=step]")];
  expect(steps.map((step) => step.textContent)).toEqual([
    setup.screens.microphone,
    setup.screens.transcription,
    setup.screens.app,
    setup.screens.context,
    setup.screens.words,
  ]);
  expect(steps[0]?.getAttribute("aria-current")).toBe("step");
});

test("the first screen picks the microphone and tests it with its level", async () => {
  const native = nativeSide({ dictation: DICTATION_ON });
  const view = await renderSetup(native);

  const select = await view.findByRole("combobox", {
    name: setup.microphone.choose,
  });
  expect(select.textContent).toContain(
    dictation.microphone.systemDefaultNamed.replace("{name}", "AirPods Pro 3"),
  );
  fireEvent.click(
    view.getByRole("button", { name: dictation.microphone.test }),
  );
  await waitFor(() => {
    expect(native.calls).toContainEqual({
      args: { id: null },
      command: "dictation_test_microphone_start",
    });
  });
  await act(async () => {
    await emit("dictation-microphone-level", {
      device: "AirPods Pro 3",
      finished: false,
      levelDb: -20,
      peakDb: -14,
      status: "hearing",
    });
  });
  await view.findByText(dictation.microphone.hearing);
  await act(async () => {
    await emit("dictation-microphone-level", {
      device: "AirPods Pro 3",
      finished: true,
      levelDb: -90,
      peakDb: -90,
      status: "silent",
    });
  });
  await view.findByText(
    dictation.microphone.noSound.replace("{device}", "AirPods Pro 3"),
  );
});

test("without dictation on this computer the step offers only to skip it", async () => {
  // A whole snapshot, so only its `available` flag hides the setup.
  const { findByRole, queryByRole, queryByText } = await renderSetup(
    nativeSide({ dictation: { ...DICTATION_OFF, available: false } }),
  );

  await findByRole("button", { name: onboarding.skip });
  expect(queryByRole("button", { name: onboarding.continue })).toBeNull();
  expect(queryByText(setup.microphone.title)).toBeNull();
});

test("Continue on the first screen turns dictation on without downloading the model", async () => {
  const native = nativeSide();
  const view = await renderSetup(native);

  await continueTo(view, setup.transcription.titleLocal);

  expect(native.calls).toContainEqual({
    args: { enabled: true },
    command: "dictation_set_enabled",
  });
  expect(sentCommands(native)).not.toContain("dictation_download_model");
});

test("without stella AI the transcription screen is a fact, not a choice, with the model's download and progress", async () => {
  const native = nativeSide({ dictation: DICTATION_ON });
  const view = await renderSetup(native);
  await continueTo(view, setup.transcription.titleLocal);

  expect(view.queryByRole("radio")).toBeNull();
  expect(view.queryByText(setup.transcription.cloudTitle)).toBeNull();
  await view.findByText(setup.transcription.localBody);
  fireEvent.click(
    await view.findByRole("button", {
      name: dictation.download.replace("{size}", "740"),
    }),
  );

  await view.findByText(dictation.downloading.replace("{percent}", "0"));
  native.dictation = {
    ...DICTATION_ON,
    model: { received: 370_181_584, status: "downloading", total: 740_363_168 },
  };
  await act(async () => {
    await emit("dictation-changed");
  });
  await view.findByText(dictation.downloading.replace("{percent}", "50"));
  await view.findByText(onboarding.dictationDownloadContinues);
});

test("a model already in place is said so and not downloaded again", async () => {
  const native = nativeSide({
    dictation: { ...DICTATION_ON, model: { status: "ready" } },
  });
  const view = await renderSetup(native);
  await continueTo(view, setup.transcription.titleLocal);

  await view.findByText(dictation.modelInstalled.replace("{size}", "740"));
  expect(
    view.queryByRole("button", {
      name: dictation.download.replace("{size}", "740"),
    }),
  ).toBeNull();
});

test("with stella AI the screen is a choice of two, and stella AI shows its model, labels and warning", async () => {
  const native = nativeSide({
    dictation: { ...DICTATION_ON, cloudAvailable: true },
  });
  const view = await renderSetup(native);
  await continueTo(view, setup.transcription.title);

  const radios = view.getAllByRole("radio");
  expect(radios).toHaveLength(2);
  const [local, cloud] = radios;
  expect(local?.getAttribute("value")).toBe("local");
  expect(local instanceof HTMLInputElement && local.checked).toBe(true);
  expect(view.queryByText(dictation.destination.model)).toBeNull();

  if (cloud) {
    fireEvent.click(cloud);
  }
  await waitFor(() => {
    expect(native.calls).toContainEqual({
      args: { destination: "cloud" },
      command: "dictation_set_destination",
    });
  });
  await view.findByText(dictation.destination.model);
  // The model appearing under the card keeps the chosen radio in place.
  expect(cloud?.isConnected).toBe(true);
  await view.findByText("Mistral AI");
  expect(view.queryByRole("alert")).toBeNull();

  // A model whose provider keeps the audio warns once it is chosen.
  native.dictation = {
    ...DICTATION_ON,
    cloudAvailable: true,
    cloudModel: "elevenlabs-direct/scribe-v3",
    destination: "cloud",
  };
  await act(async () => {
    await emit("dictation-changed");
  });
  await view.findByText(
    dictation.destination.retainsDataTitle.replace("{provider}", "ElevenLabs"),
  );
  await view.findByText(dictation.destination.outsideRegion);
  await view.findByText(dictation.destination.retainsData);
});

test("the app screen shows AI cleanup, on by default, and what it is told about the app", async () => {
  const native = nativeSide({ dictation: DICTATION_ON });
  const view = await renderSetup(native);
  await continueTo(view, setup.app.title);

  const toggle = await view.findByRole("switch", {
    name: dictation.cleanup.title,
  });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await view.findByText(setup.app.sentAppKind);
  await view.findByText(setup.app.notStored);

  fireEvent.click(toggle);
  await waitFor(() => {
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
  expect(native.calls).toContainEqual({
    args: { enabled: false },
    command: "dictation_set_cleanup",
  });
  // Nothing is left for more context or custom words: the step is done.
  await view.findByText(setup.app.off);
  const steps = [...view.container.querySelectorAll("[data-slot=step]")];
  expect(steps.map((step) => step.textContent)).toEqual([
    setup.screens.microphone,
    setup.screens.transcription,
    setup.screens.app,
  ]);
  fireEvent.click(view.getByRole("button", { name: onboarding.continue }));
  await waitFor(() => {
    expect(native.calls).toContainEqual({
      args: { from: "dictation", input: "continue" },
      command: "onboarding_advance",
    });
  });
});

test("more context starts off and turns on one piece at a time", async () => {
  const native = nativeSide({ dictation: DICTATION_ON });
  const view = await renderSetup(native);
  await continueTo(view, setup.context.title);

  const title = await view.findByRole("switch", {
    name: dictation.context.windowTitle.title,
  });
  const before = await view.findByRole("switch", {
    name: dictation.context.textBeforeCursor.title,
  });
  expect(title.getAttribute("aria-checked")).toBe("false");
  expect(before.getAttribute("aria-checked")).toBe("false");
  await view.findByText(dictation.context.windowTitle.description);

  fireEvent.click(title);
  await waitFor(() => {
    expect(title.getAttribute("aria-checked")).toBe("true");
  });
  expect(native.calls).toContainEqual({
    args: { enabled: true },
    command: "dictation_set_share_window_title",
  });
  expect(sentCommands(native)).not.toContain(
    "dictation_set_share_text_before_cursor",
  );
});

test("a computer that cannot read the text before the cursor does not offer it", async () => {
  const view = await renderSetup(
    nativeSide({
      dictation: { ...DICTATION_ON, textBeforeCursorAvailable: false },
    }),
  );
  await continueTo(view, setup.context.title);

  await view.findByRole("switch", {
    name: dictation.context.windowTitle.title,
  });
  expect(
    view.queryByRole("switch", {
      name: dictation.context.textBeforeCursor.title,
    }),
  ).toBeNull();
});

test("custom words start empty; an idea asks for the word and adding it stores the list", async () => {
  const native = nativeSide({ dictation: DICTATION_ON });
  const view = await renderSetup(native);
  await continueTo(view, setup.words.title);

  const field = await view.findByRole("textbox", {
    name: dictation.customWords.input,
  });
  expect(
    view.queryByRole("list", { name: dictation.customWords.group }),
  ).toBeNull();

  fireEvent.click(
    view.getByRole("button", { name: setup.words.examples.firm }),
  );
  expect(field.getAttribute("placeholder")).toBe(setup.words.examples.firm);
  expect(sentCommands(native)).not.toContain("dictation_set_custom_words");

  fireEvent.change(field, { target: { value: "Novák & Partners" } });
  fireEvent.submit(field.closest("form") ?? field);
  await waitFor(() => {
    expect(native.calls).toContainEqual({
      args: { words: ["Novák & Partners"] },
      command: "dictation_set_custom_words",
    });
  });
  await view.findByText("Novák & Partners");
  // The last screen ends the step with Continue; there is nothing to skip.
  expect(view.queryByRole("button", { name: onboarding.skipRest })).toBeNull();
});

test("Skip on the first screen moves the tour on without turning dictation on", async () => {
  const native = nativeSide();
  const { findByRole } = await renderSetup(native);

  fireEvent.click(await findByRole("button", { name: onboarding.skip }));

  await waitFor(() => {
    expect(native.calls).toContainEqual({
      args: { from: "dictation", input: "continue" },
      command: "onboarding_advance",
    });
  });
  expect(sentCommands(native)).not.toContain("dictation_set_enabled");
});

test("Skip the rest leaves the step and keeps what was chosen", async () => {
  const native = nativeSide({ dictation: DICTATION_ON });
  const view = await renderSetup(native);
  await continueTo(view, setup.transcription.titleLocal);

  fireEvent.click(view.getByRole("button", { name: onboarding.skipRest }));

  await waitFor(() => {
    expect(native.calls).toContainEqual({
      args: { from: "dictation", input: "continue" },
      command: "onboarding_advance",
    });
  });
  expect(sentCommands(native)).not.toContain("dictation_set_enabled");
});

test("Back walks the screens back, then leaves for the step before", async () => {
  const native = nativeSide({ dictation: DICTATION_ON });
  const view = await renderSetup(native);
  await continueTo(view, setup.app.title);

  fireEvent.click(view.getByRole("button", { name: onboarding.back }));
  await view.findByRole("heading", {
    level: 1,
    name: setup.transcription.titleLocal,
  });
  fireEvent.click(view.getByRole("button", { name: onboarding.back }));
  await view.findByRole("heading", { level: 1, name: setup.microphone.title });
  expect(sentCommands(native)).not.toContain("onboarding_advance");

  fireEvent.click(view.getByRole("button", { name: onboarding.back }));
  await waitFor(() => {
    expect(native.calls).toContainEqual({
      args: { from: "dictation", input: "back" },
      command: "onboarding_advance",
    });
  });
});

test("a dictation state that cannot be read says so and reads again on request", async () => {
  const native = nativeSide({ dictationUnreadable: true });
  const { findByRole, findByText, queryByRole, queryByText } =
    await renderSetup(native);

  await findByText(onboarding.errorLoad);
  expect(queryByRole("button", { name: onboarding.continue })).toBeNull();

  native.dictationUnreadable = false;
  fireEvent.click(await findByRole("button", { name: onboarding.tryAgain }));

  await findByRole("button", { name: onboarding.continue });
  expect(queryByText(onboarding.errorLoad)).toBeNull();
});

test("a later read that fails keeps the screen and says so", async () => {
  const native = nativeSide();
  const { findByRole, findByText, getByRole } = await renderSetup(native);
  await findByRole("button", { name: onboarding.continue });

  native.dictationUnreadable = true;
  await act(async () => {
    await emit("dictation-changed");
  });

  await findByText(onboarding.errorLoad);
  expect(getByRole("heading", { level: 1 }).textContent).toBe(
    setup.microphone.title,
  );
  expect(getByRole("button", { name: onboarding.tryAgain })).toBeTruthy();
});

test("a dictation that typed nothing says why on the microphone screen", async () => {
  const { findByText } = await renderSetup(
    nativeSide({
      dictation: { ...DICTATION_ON, failure: "shortcutHeld" },
    }),
  );

  await findByText(dictation.failure.shortcutHeld);
});

test("a failure setup has no text for leaves the screen as it is", async () => {
  const { findByRole, queryByRole, queryByText } = await renderSetup(
    nativeSide({
      dictation: { ...DICTATION_ON, failure: "notNamedHere" },
    }),
  );

  await findByRole("heading", { level: 1, name: setup.microphone.title });
  expect(queryByRole("status")).toBeNull();
  expect(queryByText(onboarding.errorLoad)).toBeNull();
});

test("dictation that arrives after setup walks the same screens and closes once", async () => {
  const native = nativeSide({
    onboarding: {
      ...DICTATION_STEP,
      mode: { feature: "dictation", type: "introduce" },
      step: "done",
    },
  });
  const { container, findByRole, findByText, queryByRole } =
    await renderSetup(native);

  await findByRole("heading", { level: 1, name: setup.microphone.title });
  await findByText(onboarding.introduceDictationTitle);
  expect(container.querySelectorAll("[data-slot=step]")).toHaveLength(5);
  // Nothing comes before it in this window.
  expect(queryByRole("button", { name: onboarding.back })).toBeNull();
  fireEvent.click(await findByRole("button", { name: onboarding.later }));

  await waitFor(() => {
    expect(sentCommands(native)).toContain("onboarding_dismiss");
  });
  expect(sentCommands(native)).not.toContain("onboarding_advance");
  expect(sentCommands(native)).not.toContain("dictation_set_enabled");
});
