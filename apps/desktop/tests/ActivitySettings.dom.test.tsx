import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost/" });

const { act, cleanup, fireEvent, render, waitFor } =
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
const renderPane = async (native: {
  readable: boolean;
  captureDetails?: boolean;
  detailsAccess?: "disabled" | "managed";
  draftPolicy?: "account" | "managedOff";
}) => {
  mockIPC(
    (command, args) => {
      if (command === "activity_get_settings") {
        if (!native.readable) {
          throw new Error("activity account unavailable");
        }
        return {
          ...SETTINGS,
          captureDetails: native.captureDetails ?? SETTINGS.captureDetails,
          detailsAccess: native.detailsAccess ?? SETTINGS.detailsAccess,
        };
      }
      if (
        command === "billing_draft_get_settings" &&
        native.draftPolicy !== undefined
      ) {
        return {
          policy: native.draftPolicy,
          scopeKey: '["org_fixture","user_fixture"]',
          settings: {
            consent: "revoked",
            effectiveMode:
              native.draftPolicy === "managedOff" ? "off" : "plain",
            preference: null,
            revision: "revision-1",
          },
        };
      }
      if (command === "activity_set_detect_calls") {
        throw new Error("rejected");
      }
      if (
        command === "activity_set_capture_details" &&
        args !== undefined &&
        "enabled" in args &&
        typeof args["enabled"] === "boolean"
      ) {
        native.captureDetails = args["enabled"];
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

test("the title setting describes what flipping it does in its current state", async () => {
  const native = { readable: true, captureDetails: false };
  const { findByRole } = await renderPane(native);
  const checkbox = await findByRole("checkbox", {
    name: messages.captureDetails,
  });
  const description = () =>
    document.querySelector(
      `#${checkbox.getAttribute("aria-describedby") ?? ""}`,
    )?.textContent;
  expect(checkbox.getAttribute("aria-checked")).toBe("false");
  expect(description()).toBe(messages.captureDetailsOffDescription);

  fireEvent.click(checkbox);
  // The native side applies the change, then announces it.
  await waitFor(() => {
    expect(native.captureDetails).toBe(true);
  });
  await act(async () => {
    await emit(ACTIVITY_CHANGED_EVENT);
  });

  expect(
    (
      await findByRole("checkbox", { name: messages.captureDetails })
    ).getAttribute("aria-checked"),
  ).toBe("true");
  expect(description()).toBe(messages.captureDetailsDescription);
});

test("where policy keeps details off, the row says so and offers nothing to turn on", async () => {
  const { findAllByText, queryByRole } = await renderPane({
    readable: true,
    detailsAccess: "managed",
  });
  // The row and the per-app list both say who decided.
  expect((await findAllByText(messages.detailsManaged)).length).toBeGreaterThan(
    0,
  );
  expect(queryByRole("checkbox", { name: messages.captureDetails })).toBeNull();
  expect(
    document.body.textContent.includes(messages.captureModesDetailsOff),
  ).toBe(false);
});

test("where policy turns drafts off, the drafts row says so and asks for no consent", async () => {
  const { findByText, queryByRole } = await renderPane({
    readable: true,
    draftPolicy: "managedOff",
  });
  await findByText(messages.billingDraftsManaged);
  expect(queryByRole("button", { name: messages.aiDraftAllow })).toBeNull();
});
