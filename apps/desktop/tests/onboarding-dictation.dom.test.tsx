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

test("the dictation step names the macOS shortcut and that speech stays on this computer", async () => {
  const { findByText, getByRole } = await renderSetup(nativeSide());

  await findByText(dictation.description.replace("{shortcut}", "⌃⌥Space"));
  expect(getByRole("heading", { level: 1 }).textContent).toBe(dictation.title);
  expect(
    getByRole("button", { name: onboarding.dictationTurnOn }),
  ).toBeTruthy();
});

test("without dictation on this computer the step offers nothing to turn on", async () => {
  // A whole snapshot, so only its `available` flag hides the setup.
  const { container, findByRole, queryByRole } = await renderSetup(
    nativeSide({ dictation: { ...DICTATION_OFF, available: false } }),
  );

  await findByRole("button", { name: onboarding.skip });
  expect(
    queryByRole("button", { name: onboarding.dictationTurnOn }),
  ).toBeNull();
  const explanation = dictation.description.split("{shortcut}").at(1) ?? "";
  expect(explanation.length).toBeGreaterThan(0);
  expect(container.textContent).not.toContain(explanation);
});

test("turning dictation on starts the model download and shows its progress", async () => {
  const native = nativeSide();
  const { findByRole, findByText, getByRole } = await renderSetup(native);

  fireEvent.click(
    await findByRole("button", { name: onboarding.dictationTurnOn }),
  );

  await findByText(dictation.downloading.replace("{percent}", "0"));
  const commands = sentCommands(native);
  expect(commands.indexOf("dictation_set_enabled")).toBeGreaterThan(-1);
  expect(commands.indexOf("dictation_download_model")).toBeGreaterThan(
    commands.indexOf("dictation_set_enabled"),
  );
  expect(native.calls).toContainEqual({
    args: { enabled: true },
    command: "dictation_set_enabled",
  });
  // Dictation is on: the step moves on with Continue, not Skip.
  expect(getByRole("button", { name: onboarding.continue })).toBeTruthy();

  native.dictation = {
    ...DICTATION_OFF,
    enabled: true,
    model: { received: 370_181_584, status: "downloading", total: 740_363_168 },
  };
  await act(async () => {
    await emit("dictation-changed");
  });

  await findByText(dictation.downloading.replace("{percent}", "50"));
});

test("a model already in place is not downloaded again", async () => {
  const native = nativeSide({
    dictation: { ...DICTATION_OFF, model: { status: "ready" } },
  });
  const { findByRole, findByText } = await renderSetup(native);

  fireEvent.click(
    await findByRole("button", { name: onboarding.dictationTurnOn }),
  );

  await findByText(onboarding.dictationReady);
  expect(sentCommands(native)).not.toContain("dictation_download_model");
});

test("once ready it asks for the microphone and offers a field to dictate into", async () => {
  const { findByRole, findByText } = await renderSetup(
    nativeSide({
      dictation: {
        ...DICTATION_OFF,
        enabled: true,
        model: { status: "ready" },
      },
    }),
  );

  await findByRole("textbox", { name: onboarding.dictationTryLabel });
  await findByText(defaultMessages.settings.permissionMicrophone);
  await findByText(onboarding.dictationMicrophone);
  await findByText(onboarding.dictationAccessibility);
});

test("a dictation state that cannot be read says so and reads again on request", async () => {
  const native = nativeSide({ dictationUnreadable: true });
  const { findByRole, findByText, queryByRole, queryByText } =
    await renderSetup(native);

  await findByText(onboarding.errorLoad);
  expect(
    queryByRole("button", { name: onboarding.dictationTurnOn }),
  ).toBeNull();

  native.dictationUnreadable = false;
  fireEvent.click(await findByRole("button", { name: onboarding.tryAgain }));

  await findByRole("button", { name: onboarding.dictationTurnOn });
  expect(queryByText(onboarding.errorLoad)).toBeNull();
});

test("a later read that fails keeps the setup and says so", async () => {
  const native = nativeSide();
  const { findByRole, findByText, getByRole } = await renderSetup(native);
  await findByRole("button", { name: onboarding.dictationTurnOn });

  native.dictationUnreadable = true;
  await act(async () => {
    await emit("dictation-changed");
  });

  await findByText(onboarding.errorLoad);
  expect(
    getByRole("button", { name: onboarding.dictationTurnOn }),
  ).toBeTruthy();
  expect(getByRole("button", { name: onboarding.tryAgain })).toBeTruthy();
});

test("a dictation that typed nothing says why, and the setup stays", async () => {
  const native = nativeSide({
    dictation: {
      ...DICTATION_OFF,
      enabled: true,
      failure: "shortcutHeld",
      model: { status: "ready" },
    },
  });
  const { findByRole, findByText } = await renderSetup(native);

  await findByText(dictation.failure.shortcutHeld);
  await findByRole("textbox", { name: onboarding.dictationTryLabel });
});

test("a failure setup has no text for leaves the setup as it is", async () => {
  const native = nativeSide({
    dictation: {
      ...DICTATION_OFF,
      enabled: true,
      failure: "notNamedHere",
      model: { status: "ready" },
    },
  });
  const { findByRole, queryByRole, queryByText } = await renderSetup(native);

  await findByRole("textbox", { name: onboarding.dictationTryLabel });
  expect(queryByRole("status")).toBeNull();
  expect(queryByText(onboarding.errorLoad)).toBeNull();
});

test("skipping moves the tour on without turning dictation on", async () => {
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

test("dictation that arrives after setup is introduced and closed once", async () => {
  const native = nativeSide({
    onboarding: {
      ...DICTATION_STEP,
      mode: { feature: "dictation", type: "introduce" },
      step: "done",
    },
  });
  const { findByRole } = await renderSetup(native);

  await findByRole("heading", { name: onboarding.introduceDictationTitle });
  await findByRole("button", { name: onboarding.dictationTurnOn });
  fireEvent.click(await findByRole("button", { name: onboarding.later }));

  await waitFor(() => {
    expect(sentCommands(native)).toContain("onboarding_dismiss");
  });
  expect(sentCommands(native)).not.toContain("onboarding_advance");
});
