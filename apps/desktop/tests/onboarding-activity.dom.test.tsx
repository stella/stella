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
const { clearMocks } = await import("@tauri-apps/api/mocks");
const { DesktopIntlProvider, defaultMessages } = await import("../src/i18n");
const { default: OnboardingApp } =
  await import("../src/onboarding/OnboardingApp");
const {
  ACTIVITY_INTRODUCTION,
  ACTIVITY_OFF,
  DRAFTS_OFFERED,
  installNativeSide,
  SCOPE_KEY,
  nativeSide,
  sentCommands,
} = await import("./onboarding-activity-native");

// React's scheduler and the mocked IPC answers run on a macrotask; each
// test and the file let one pass while the DOM is still registered.
afterEach(async () => {
  await act(nextMacrotask);
  cleanup();
  clearMocks();
  localStorage.clear();
});

afterAll(async () => {
  await nextMacrotask();
  await GlobalRegistrator.unregister();
});

const onboarding = defaultMessages.onboarding;
const setup = defaultMessages.onboarding.activitySetup;
const activity = defaultMessages.activity;
const settings = defaultMessages.settings;

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

const heading = async (view: View, name: string) =>
  view.findByRole("heading", { level: 1, name });

const click = async (view: View, name: string) => {
  fireEvent.click(await view.findByRole("button", { name }));
  await act(nextMacrotask);
};

const RECORDING = { ...ACTIVITY_OFF, recordingStatus: "recording" } as const;

type DetailsChoice = keyof typeof setup.details.choices;

const detailsChoice = (view: View, choice: DetailsChoice) =>
  view.getByRole("radio", {
    name: (name) => name.startsWith(setup.details.choices[choice]),
  });

const isChecked = (element: HTMLElement) =>
  element instanceof HTMLInputElement && element.checked;

const answerDetails = async (view: View, choice: DetailsChoice) => {
  fireEvent.click(detailsChoice(view, choice));
  await act(nextMacrotask);
};

/** From the details screen to the screen after it, choosing app names. */
const pastDetails = async (view: View) => {
  await heading(view, setup.details.title);
  await answerDetails(view, "appNamesOnly");
  await click(view, onboarding.continue);
};

/** From a started first screen to the drafts screen. */
const toDrafts = async (view: View) => {
  await click(view, onboarding.continue);
  await pastDetails(view);
  await click(view, onboarding.continue);
};

test("the first screen tells what is recorded and sent, and starts nothing on its own", async () => {
  const native = nativeSide();
  const view = await renderSetup(native);

  await heading(view, onboarding.activityTitle);
  const steps = [...view.container.querySelectorAll("[data-slot=step]")];
  expect(steps.map((step) => step.textContent)).toEqual([
    setup.screens.recording,
    setup.screens.details,
    setup.screens.calls,
    setup.screens.aiDrafts,
  ]);
  expect(steps[0]?.getAttribute("aria-current")).toBe("step");
  // The same facts as every other surface, from their one owner.
  await view.findByText(
    (content) =>
      content.includes(activity.disclosure.aiDraftProvider) &&
      Object.values(activity.disclosure.aiDraftInputs).every((input) =>
        content.includes(input),
      ),
  );
  await view.findByText(activity.disclosure.recorded.browserTitles);
  await view.findByText(activity.disclosure.never.webAddresses);
  view.getByRole("button", { name: activity.welcomeStart });

  await click(view, onboarding.skip);
  expect(sentCommands(native)).not.toContain("activity_set_recording_status");
  expect(sentCommands(native)).toContain("onboarding_advance");
});

test("Start recording starts it and moves on to window details", async () => {
  const native = nativeSide();
  const view = await renderSetup(native);

  await click(view, activity.welcomeStart);
  await heading(view, setup.details.title);
  expect(native.calls).toContainEqual({
    args: { status: "recording" },
    command: "activity_set_recording_status",
  });
  expect(native.activity.recordingStatus).toBe("recording");
});

test("the details screen offers both answers, neither chosen, and continues only once one is", async () => {
  const native = nativeSide({ activity: RECORDING });
  const view = await renderSetup(native);
  await click(view, onboarding.continue);
  await heading(view, setup.details.title);

  for (const choice of ["appNamesOnly", "withDetails"] as const) {
    expect(isChecked(detailsChoice(view, choice))).toBe(false);
  }
  // What each answer records and where it stays, from the disclosure.
  view.getByText(activity.disclosure.recorded.app);
  view.getByText(activity.disclosure.recorded.details);
  view.getByText(activity.disclosure.detailsStay);
  expect(view.queryByText(settings.permissionAccessibility)).toBeNull();
  const next = view.getByRole("button", { name: onboarding.continue });
  expect(next.hasAttribute("disabled") || next.ariaDisabled === "true").toBe(
    true,
  );
  fireEvent.click(next);
  await act(nextMacrotask);
  await heading(view, setup.details.title);
  expect(sentCommands(native)).not.toContain("activity_set_capture_details");

  await answerDetails(view, "withDetails");
  expect(native.calls).toContainEqual({
    args: { enabled: true },
    command: "activity_set_capture_details",
  });
  await waitFor(() => {
    expect(isChecked(detailsChoice(view, "withDetails"))).toBe(true);
  });
  await view.findByText(settings.permissionAccessibility);
  await view.findByText(setup.details.browsers);

  await answerDetails(view, "appNamesOnly");
  expect(native.calls).toContainEqual({
    args: { enabled: false },
    command: "activity_set_capture_details",
  });
  await waitFor(() => {
    expect(view.queryByText(settings.permissionAccessibility)).toBeNull();
  });
  await click(view, onboarding.continue);
  await heading(view, setup.calls.title);
  expect(native.activity.captureDetails).toBe(false);
});

test("a choice saved before is not shown as chosen; the screen asks again", async () => {
  const native = nativeSide({
    activity: { ...RECORDING, captureDetails: true, detailsAccess: "ready" },
  });
  const view = await renderSetup(native);
  await click(view, onboarding.continue);
  await heading(view, setup.details.title);

  for (const choice of ["appNamesOnly", "withDetails"] as const) {
    expect(isChecked(detailsChoice(view, choice))).toBe(false);
  }
  expect(view.queryByText(settings.permissionAccessibility)).toBeNull();
  // Leaving without an answer keeps what was saved.
  await click(view, onboarding.skipRest);
  expect(sentCommands(native)).not.toContain("activity_set_capture_details");
  expect(native.activity.captureDetails).toBe(true);
});

test("the calls screen writes the stored choice", async () => {
  const native = nativeSide({ activity: RECORDING });
  const view = await renderSetup(native);
  await click(view, onboarding.continue);
  await pastDetails(view);
  await heading(view, setup.calls.title);

  fireEvent.click(view.getByRole("switch", { name: activity.detectCalls }));
  await act(nextMacrotask);
  expect(native.calls).toContainEqual({
    args: { enabled: false },
    command: "activity_set_detect_calls",
  });
  expect(native.activity.detectCalls).toBe(false);
});

test("the drafts screen asks with the card's consent and grants it on the account", async () => {
  const native = nativeSide({ activity: RECORDING });
  const view = await renderSetup(native);
  await toDrafts(view);
  await heading(view, activity.billingDraftsTitle);

  await view.findByText((content) =>
    content.includes(activity.disclosure.aiDraftProvider),
  );
  const allow = view.getByRole("switch", { name: setup.aiDrafts.allow });
  expect(allow.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(allow);
  await waitFor(() => {
    expect(native.drafts.consent).toBe("granted");
  });
  expect(native.calls).toContainEqual({
    args: { revision: DRAFTS_OFFERED.revision, scopeKey: SCOPE_KEY },
    command: "billing_draft_grant_consent",
  });
  // The last screen leaves the step with the tour's Continue.
  expect(view.queryByRole("button", { name: onboarding.skipRest })).toBeNull();
});

test("a grant the server refuses says so and can be tried again", async () => {
  const native = nativeSide({ activity: RECORDING, grantRefusals: 1 });
  const view = await renderSetup(native);
  await toDrafts(view);
  await heading(view, activity.billingDraftsTitle);

  const allow = () => view.getByRole("switch", { name: setup.aiDrafts.allow });
  fireEvent.click(allow());
  await view.findByText(activity.errorUpdate);
  expect(native.drafts.consent).toBe("revoked");
  await waitFor(() => {
    expect(allow().getAttribute("aria-checked")).toBe("false");
  });

  fireEvent.click(allow());
  await waitFor(() => {
    expect(native.drafts.consent).toBe("granted");
  });
  await waitFor(() => {
    expect(allow().getAttribute("aria-checked")).toBe("true");
  });
  expect(view.queryByText(activity.errorUpdate)).toBeNull();
});

test("a withdrawal the server has not confirmed shows as pending and is sent again from the screen", async () => {
  const native = nativeSide({
    activity: RECORDING,
    drafts: { ...DRAFTS_OFFERED, consent: "granted" },
    withdrawRefusals: 1,
  });
  const view = await renderSetup(native);
  await toDrafts(view);
  await heading(view, activity.billingDraftsTitle);

  const allow = await view.findByRole("switch", {
    name: setup.aiDrafts.allow,
  });
  await waitFor(() => {
    expect(allow.getAttribute("aria-checked")).toBe("true");
  });
  fireEvent.click(allow);
  await view.findByText(activity.billingDraftsWithdrawPending);
  expect(native.drafts.consent).toBe("granted");

  await click(view, activity.retry);
  await waitFor(() => {
    expect(native.drafts.consent).toBe("revoked");
  });
  await waitFor(() => {
    expect(view.queryByText(activity.billingDraftsWithdrawPending)).toBeNull();
  });
});

test("the introduction offers to open activity once recording has started, paused or not", async () => {
  const native = nativeSide({
    activity: { ...ACTIVITY_OFF, recordingStatus: "paused" },
    onboarding: ACTIVITY_INTRODUCTION,
  });
  const view = await renderSetup(native);
  await toDrafts(view);
  await heading(view, activity.billingDraftsTitle);
  view.getByRole("button", { name: onboarding.openActivity });
  expect(sentCommands(native)).not.toContain("activity_set_recording_status");
});

test("without drafting for the firm, calls is the last screen", async () => {
  const native = nativeSide({
    activity: RECORDING,
    drafts: { ...DRAFTS_OFFERED, effectiveMode: "off" },
  });
  const view = await renderSetup(native);
  await heading(view, onboarding.activityTitle);
  const steps = [...view.container.querySelectorAll("[data-slot=step]")];
  expect(steps.map((step) => step.textContent)).toEqual([
    setup.screens.recording,
    setup.screens.details,
    setup.screens.calls,
  ]);
});

test("where details cannot be read or policy keeps them off, their screen is left out", async () => {
  for (const detailsAccess of ["unavailable", "managed"] as const) {
    const native = nativeSide({ activity: { ...RECORDING, detailsAccess } });
    const view = await renderSetup(native);
    await click(view, onboarding.continue);
    await heading(view, setup.calls.title);
    expect(sentCommands(native)).not.toContain("activity_set_capture_details");
    await act(nextMacrotask);
    cleanup();
  }
});

test("where policy turns drafts off, calls is the last screen and nothing asks for consent", async () => {
  const native = nativeSide({ activity: RECORDING, draftPolicy: "managedOff" });
  const view = await renderSetup(native);
  await heading(view, onboarding.activityTitle);
  const steps = [...view.container.querySelectorAll("[data-slot=step]")];
  expect(steps.map((step) => step.textContent)).toEqual([
    setup.screens.recording,
    setup.screens.details,
    setup.screens.calls,
  ]);
  expect(sentCommands(native)).not.toContain("billing_draft_grant_consent");
});

test("Skip the rest leaves the step with what was chosen", async () => {
  const native = nativeSide({ activity: RECORDING });
  const view = await renderSetup(native);
  await click(view, onboarding.continue);
  await heading(view, setup.details.title);

  await click(view, onboarding.skipRest);
  expect(sentCommands(native)).toContain("onboarding_advance");
  expect(sentCommands(native)).not.toContain("activity_set_capture_details");
});

test("a state that cannot be read says so and reads again", async () => {
  const native = nativeSide({ activityUnreadable: true });
  const view = await renderSetup(native);

  await view.findByText(onboarding.errorLoad);
  native.activityUnreadable = false;
  await click(view, onboarding.tryAgain);
  await heading(view, onboarding.activityTitle);
});

test("the introduction runs the same screens and ends in Done", async () => {
  const native = nativeSide({ onboarding: ACTIVITY_INTRODUCTION });
  const view = await renderSetup(native);

  await heading(view, onboarding.activityTitle);
  await view.findByText(onboarding.introduceActivityBody);
  view.getByRole("navigation", { name: onboarding.introduceActivityTitle });

  await click(view, activity.welcomeStart);
  await pastDetails(view);
  await click(view, onboarding.continue);
  await heading(view, activity.billingDraftsTitle);
  view.getByRole("button", { name: onboarding.openActivity });
  await click(view, onboarding.done);
  expect(sentCommands(native)).toContain("onboarding_dismiss");
});

test("Later on the introduction's first screen leaves recording off", async () => {
  const native = nativeSide({ onboarding: ACTIVITY_INTRODUCTION });
  const view = await renderSetup(native);

  await click(view, onboarding.later);
  expect(sentCommands(native)).toContain("onboarding_dismiss");
  expect(sentCommands(native)).not.toContain("activity_set_recording_status");
});
