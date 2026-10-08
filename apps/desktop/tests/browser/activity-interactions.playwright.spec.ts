import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  ACTIVITY_CHANGED_EVENT,
  isActivityDaySnapshot,
} from "../../src/activity/activity-types";
import type { ActivityDaySnapshot } from "../../src/activity/activity-types";
import enMessages from "../../src/i18n/langs/en.json" with { type: "json" };

const SNAPSHOT = {
  date: "2026-10-07",
  draftedEntries: [],
  timeBillingEnabled: true,
  earliestDate: "2026-10-01",
  excludedApps: [],
  otherAccountHistoryDays: 0,
  captureDetails: false,
  appNameOnlyApps: [],
  browserApps: [],
  browserTitleApps: [],
  detailsAccess: "disabled",
  persistence: "encrypted",
  recordingStatus: "recording",
  retention: "month",
  segments: [
    {
      appIdentifier: "com.example.editor",
      appName: "Example Editor",
      start: "2026-10-07T09:00:00Z",
      end: "2026-10-07T09:30:00Z",
    },
  ],
  today: "2026-10-07",
  unreadable: false,
} satisfies ActivityDaySnapshot;

const installNativeBoundary = async (
  page: Page,
  snapshot: ActivityDaySnapshot = SNAPSHOT,
) => {
  expect(isActivityDaySnapshot(snapshot)).toBe(true);
  await page.addInitScript(
    ({ snapshot: initialSnapshot, changedEvent }) => {
      const callbacks = new Map<number, (data: unknown) => unknown>();
      const invocations: { args: Record<string, unknown>; command: string }[] =
        [];
      let nextCallbackId = 1;
      let activitySnapshot = initialSnapshot;
      Reflect.set(window, "__STELLA_TEST_INVOCATIONS__", invocations);
      const emitActivityChanged = () => {
        const subscription = invocations.findLast(
          ({ args, command }) =>
            command === "plugin:event|listen" && args["event"] === changedEvent,
        );
        const id = subscription?.args["handler"];
        if (typeof id !== "number") {
          throw new TypeError("Activity listener is not installed");
        }
        callbacks.get(id)?.({ event: changedEvent, id, payload: null });
      };
      Reflect.set(
        window,
        "__STELLA_TEST_ACTIVITY_CHANGED__",
        emitActivityChanged,
      );
      Reflect.set(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
        unregisterListener: () => undefined,
      });
      Reflect.set(window, "__TAURI_INTERNALS__", {
        callbacks,
        convertFileSrc: (path: string) => path,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          invocations.push({ args, command });
          if (command === "activity_get_day") {
            return {
              ...activitySnapshot,
              date: args["date"] ?? activitySnapshot.date,
            };
          }
          if (command === "activity_delete_other_account_history") {
            activitySnapshot = {
              ...activitySnapshot,
              otherAccountHistoryDays: 0,
            };
            emitActivityChanged();
          }
          if (command === "activity_set_capture_details") {
            const enabled = args["enabled"];
            if (typeof enabled !== "boolean") {
              throw new TypeError("Capture choice must be explicit");
            }
            let detailsAccess = activitySnapshot.detailsAccess;
            if (!enabled) {
              detailsAccess = "disabled";
            } else if (detailsAccess !== "accessibilityRequired") {
              detailsAccess = "ready";
            }
            activitySnapshot = {
              ...activitySnapshot,
              captureDetails: enabled,
              detailsAccess,
            };
            emitActivityChanged();
          }
          if (command === "activity_set_app_detail_capture") {
            const identifier = args["identifier"];
            const name = args["name"];
            if (typeof identifier !== "string" || typeof name !== "string") {
              throw new TypeError("App identity is missing");
            }
            const appNameOnlyApps = activitySnapshot.appNameOnlyApps.filter(
              (app) => app.identifier !== identifier,
            );
            if (args["mode"] === "appNameOnly") {
              appNameOnlyApps.push({ identifier, name });
            }
            activitySnapshot = { ...activitySnapshot, appNameOnlyApps };
            emitActivityChanged();
          }
          if (command === "activity_set_browser_title_capture") {
            const identifier = args["identifier"];
            const name = args["name"];
            const enabled = args["enabled"];
            if (
              typeof identifier !== "string" ||
              typeof name !== "string" ||
              typeof enabled !== "boolean"
            ) {
              throw new TypeError("Browser choice must be explicit");
            }
            const browserTitleApps = activitySnapshot.browserTitleApps.filter(
              (browser) => browser.identifier !== identifier,
            );
            if (enabled) {
              browserTitleApps.push({ identifier, name });
            }
            activitySnapshot = { ...activitySnapshot, browserTitleApps };
            emitActivityChanged();
          }
          if (
            command === "activity_set_recording_status" &&
            args["status"] === "recording"
          ) {
            activitySnapshot = {
              ...activitySnapshot,
              recordingStatus: "recording",
            };
            emitActivityChanged();
          }
          if (command === "time_entry_search_matters") {
            return [
              { id: "matter-1", name: "Example matter", reference: "M-001" },
            ];
          }
          if (command === "time_entry_submit_confirmed") {
            return { id: "draft-1", markerSaved: true };
          }
          if (command === "get_desktop_language") {
            return "en";
          }
          if (command === "plugin:event|listen") {
            return args["handler"];
          }
          return undefined;
        },
        metadata: {
          currentWebview: { label: "activity", windowLabel: "activity" },
          currentWindow: { label: "activity" },
        },
        runCallback: (id: number, data: unknown) => callbacks.get(id)?.(data),
        transformCallback: (
          callback: ((data: unknown) => unknown) | undefined,
          once = false,
        ) => {
          const id = nextCallbackId;
          nextCallbackId += 1;
          callbacks.set(id, (data) => {
            if (once) {
              callbacks.delete(id);
            }
            return callback?.(data);
          });
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
      });
    },
    { snapshot, changedEvent: ACTIVITY_CHANGED_EVENT },
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: enMessages.activity.title, exact: true }),
  ).toBeVisible();
};

const invocations = (page: Page) =>
  page.evaluate(() => {
    const calls: unknown = Reflect.get(window, "__STELLA_TEST_INVOCATIONS__");
    return calls;
  });

for (const history of ["keep", "delete"] as const) {
  test(`excluding an app waits for the ${history} history choice`, async ({
    page,
  }) => {
    await installNativeBoundary(page);
    await page
      .getByRole("button", { name: "Stop recording Example Editor" })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await invocations(page)).not.toContainEqual(
      expect.objectContaining({ command: "activity_exclude_app" }),
    );
    await page
      .getByRole("button", {
        name:
          history === "keep"
            ? enMessages.activity.keepHistory
            : enMessages.activity.deleteHistory,
      })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(await invocations(page)).toContainEqual({
      command: "activity_exclude_app",
      args: {
        identifier: "com.example.editor",
        name: "Example Editor",
        history,
      },
    });
  });
}

test("canceling exclusion leaves recording and history unchanged", async ({
  page,
}) => {
  await installNativeBoundary(page);
  await page
    .getByRole("button", { name: "Stop recording Example Editor" })
    .click();
  await page.getByRole("button", { name: enMessages.activity.cancel }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(await invocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "activity_exclude_app" }),
  );
});

test("only explicit confirmation creates a draft with the editable billing fields", async ({
  page,
}) => {
  await installNativeBoundary(page);
  const createDraft = page.getByRole("button", {
    name: enMessages.activity.createDraftEntry,
  });
  await createDraft.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: enMessages.activity.entryNarrative }),
  ).toHaveValue("");
  await expect(
    dialog.getByRole("spinbutton", { name: enMessages.activity.entryDuration }),
  ).toHaveValue("30");
  await expect(
    dialog.getByRole("checkbox", { name: enMessages.activity.entryBillable }),
  ).toBeChecked();
  await dialog.getByRole("button", { name: "Example matter (M-001)" }).click();
  const matterSearch = dialog.getByRole("searchbox", {
    name: enMessages.activity.entryMatter,
  });
  await matterSearch.fill("Example");
  await matterSearch.press("Enter");
  expect(await invocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "time_entry_submit_confirmed" }),
  );
  await dialog
    .getByRole("button", { name: enMessages.activity.cancel })
    .click();
  await expect(dialog).toBeHidden();
  expect(await invocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "time_entry_submit_confirmed" }),
  );

  await createDraft.click();
  await expect(
    dialog.getByRole("textbox", { name: enMessages.activity.entryNarrative }),
  ).toHaveValue("");
  await dialog
    .getByRole("textbox", { name: enMessages.activity.entryNarrative })
    .fill("Draft-only confidential narrative 71f3");
  await dialog.getByRole("button", { name: "Example matter (M-001)" }).click();
  await dialog
    .getByRole("button", { name: enMessages.activity.confirmDraftEntry })
    .click();
  await expect(
    dialog.getByText(enMessages.activity.entryCreated, { exact: true }),
  ).toBeVisible();
  const timezoneId = await page.evaluate(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const calls = await invocations(page);
  expect(calls).toContainEqual({
    command: "time_entry_search_matters",
    args: { query: "" },
  });
  expect(calls).toContainEqual({
    command: "time_entry_submit_confirmed",
    args: {
      block: {
        date: "2026-10-07",
        start: "2026-10-07T09:00:00Z",
        end: "2026-10-07T09:30:00Z",
      },
      entry: {
        workspaceId: "matter-1",
        dateWorked: "2026-10-07",
        timezoneId,
        durationMinutes: 30,
        narrative: "Draft-only confidential narrative 71f3",
        billable: true,
      },
    },
  });
  expect(calls).not.toContainEqual(
    expect.objectContaining({ command: "activity_copy_text" }),
  );
  expect(calls).not.toContainEqual(
    expect.objectContaining({ command: expect.stringContaining("clipboard_") }),
  );
  expect(
    Array.isArray(calls)
      ? calls.filter(
          (call: unknown) =>
            typeof call === "object" &&
            call !== null &&
            "command" in call &&
            call.command === "time_entry_submit_confirmed",
        )
      : [],
  ).toHaveLength(1);
  await dialog
    .getByRole("button", { name: enMessages.activity.closeEntry })
    .click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText(enMessages.activity.draftedEntry, { exact: true }),
  ).toBeVisible();
  await expect(createDraft).toHaveCount(0);
  await page
    .getByRole("button", { name: enMessages.activity.copySummary })
    .click();
  await expect(
    page.getByRole("button", { name: enMessages.activity.copied }),
  ).toBeVisible();
  const callsAfterCopy = await invocations(page);
  expect(callsAfterCopy).toContainEqual({
    command: "activity_copy_text",
    args: { text: expect.stringContaining("Example Editor") },
  });
  for (const draftField of [
    "Draft-only confidential narrative 71f3",
    "Example matter",
    "M-001",
    "draft-1",
  ]) {
    expect(callsAfterCopy).not.toContainEqual({
      command: "activity_copy_text",
      args: { text: expect.stringContaining(draftField) },
    });
  }
});

test("only an explicit summary copy publishes activity to the clipboard", async ({
  page,
}) => {
  await installNativeBoundary(page);
  await page.evaluate(() => {
    const changed: unknown = Reflect.get(
      window,
      "__STELLA_TEST_ACTIVITY_CHANGED__",
    );
    if (typeof changed !== "function") {
      throw new TypeError("Activity event fixture is missing");
    }
    changed();
  });
  await page
    .getByRole("button", { name: enMessages.activity.previousDay })
    .click();
  await expect(
    page.getByRole("button", { name: enMessages.activity.nextDay }),
  ).toBeEnabled();
  const callsBeforeCopy = await invocations(page);
  expect(callsBeforeCopy).not.toContainEqual(
    expect.objectContaining({ command: "activity_copy_text" }),
  );
  expect(callsBeforeCopy).not.toContainEqual(
    expect.objectContaining({ command: expect.stringContaining("clipboard_") }),
  );
  await page
    .getByRole("button", { name: enMessages.activity.copySummary })
    .click();
  await expect(
    page.getByRole("button", { name: enMessages.activity.copied }),
  ).toBeVisible();
  const callsAfterCopy = await invocations(page);
  expect(callsAfterCopy).toContainEqual({
    command: "activity_copy_text",
    args: { text: expect.stringContaining("Example Editor") },
  });
  expect(
    Array.isArray(callsAfterCopy)
      ? callsAfterCopy.filter(
          (call: unknown) =>
            typeof call === "object" &&
            call !== null &&
            "command" in call &&
            call.command === "activity_copy_text",
        )
      : [],
  ).toHaveLength(1);
});

for (const state of [
  { persistence: "encrypted", recordingStatus: "recording" },
  { persistence: "encrypted", recordingStatus: "off" },
  { persistence: "deletionOnly", recordingStatus: "off" },
] as const) {
  test(`other-account history is count-only and deletion is confirmed in ${state.persistence}/${state.recordingStatus}`, async ({
    page,
  }) => {
    await installNativeBoundary(page, {
      ...SNAPSHOT,
      ...state,
      otherAccountHistoryDays: 3,
    });
    await expect(
      page.getByText(
        "3 saved days from other accounts remain on this device.",
        { exact: true },
      ),
    ).toBeVisible();
    const openDelete = page.getByRole("button", {
      name: enMessages.activity.deleteOtherAccountHistory,
      exact: true,
    });
    await openDelete.click();
    await expect(page.getByRole("dialog")).toContainText(
      "Delete 3 saved days from other accounts on this device? This cannot be undone.",
    );
    expect(await invocations(page)).not.toContainEqual(
      expect.objectContaining({
        command: "activity_delete_other_account_history",
      }),
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: enMessages.activity.cancel, exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(await invocations(page)).not.toContainEqual(
      expect.objectContaining({
        command: "activity_delete_other_account_history",
      }),
    );
    await openDelete.click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: enMessages.activity.delete, exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(openDelete).toBeHidden();
    expect(await invocations(page)).toContainEqual({
      command: "activity_delete_other_account_history",
      args: {},
    });
  });
}

test("no other-account history note is shown when its day count is zero", async ({
  page,
}) => {
  await installNativeBoundary(page);
  await expect(
    page.getByRole("button", {
      name: enMessages.activity.deleteOtherAccountHistory,
      exact: true,
    }),
  ).toHaveCount(0);
});

test("detail capture is unchecked in welcome and recording starts without enabling it", async ({
  page,
}) => {
  await installNativeBoundary(page, { ...SNAPSHOT, recordingStatus: "off" });
  const details = page.getByRole("checkbox", {
    name: enMessages.activity.captureDetails,
  });
  await expect(details).not.toBeChecked();
  expect(await invocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "activity_set_capture_details" }),
  );
  await page
    .getByRole("button", { name: enMessages.activity.welcomeStart })
    .click();
  await expect(
    page.getByRole("button", { name: enMessages.activity.pause, exact: true }),
  ).toBeVisible();
  await expect(details).not.toBeChecked();
  expect(await invocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "activity_set_capture_details" }),
  );
});

test("detail capture changes only on explicit choice and can be turned off in settings", async ({
  page,
}) => {
  await installNativeBoundary(page, { ...SNAPSHOT, recordingStatus: "off" });
  const details = page.getByRole("checkbox", {
    name: enMessages.activity.captureDetails,
  });
  await details.check();
  await expect(details).toBeChecked();
  expect(await invocations(page)).toContainEqual({
    command: "activity_set_capture_details",
    args: { enabled: true },
  });
  await page
    .getByRole("button", { name: enMessages.activity.welcomeStart })
    .click();
  await expect(
    page.getByRole("button", { name: enMessages.activity.pause, exact: true }),
  ).toBeVisible();
  await details.uncheck();
  await expect(details).not.toBeChecked();
  expect(await invocations(page)).toContainEqual({
    command: "activity_set_capture_details",
    args: { enabled: false },
  });
});

test("accessibility hint opens system settings only after a user request", async ({
  page,
}) => {
  await installNativeBoundary(page, {
    ...SNAPSHOT,
    captureDetails: true,
    detailsAccess: "accessibilityRequired",
  });
  await expect(
    page.getByText(enMessages.activity.accessibilityRequired, { exact: true }),
  ).toBeVisible();
  expect(await invocations(page)).not.toContainEqual(
    expect.objectContaining({
      command: "activity_open_accessibility_settings",
    }),
  );
  await page
    .getByRole("button", {
      name: enMessages.activity.openAccessibilitySettings,
    })
    .click();
  expect(await invocations(page)).toContainEqual({
    command: "activity_open_accessibility_settings",
    args: {},
  });
});

test("per-app detail controls keep time recording and allow details to be restored", async ({
  page,
}) => {
  await installNativeBoundary(page, {
    ...SNAPSHOT,
    captureDetails: true,
    detailsAccess: "ready",
  });
  await page
    .getByRole("button", { name: "Record app name only for Example Editor" })
    .click();
  await expect(
    page
      .getByRole("button", { name: "Record details for Example Editor" })
      .first(),
  ).toBeVisible();
  expect(await invocations(page)).toContainEqual({
    command: "activity_set_app_detail_capture",
    args: {
      identifier: "com.example.editor",
      name: "Example Editor",
      mode: "appNameOnly",
    },
  });
  expect(await invocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "activity_exclude_app" }),
  );
  await page
    .getByRole("button", { name: "Record details for Example Editor" })
    .first()
    .click();
  await expect(
    page.getByRole("button", {
      name: "Record app name only for Example Editor",
    }),
  ).toBeVisible();
  expect(await invocations(page)).toContainEqual({
    command: "activity_set_app_detail_capture",
    args: {
      identifier: "com.example.editor",
      name: "Example Editor",
      mode: "includeDetails",
    },
  });
});

test("browser title capture is a separate unticked opt-in and can be turned off", async ({
  page,
}) => {
  const browser = {
    identifier: "native-classified.browser",
    name: "Native Browser",
  };
  await installNativeBoundary(page, {
    ...SNAPSHOT,
    captureDetails: true,
    detailsAccess: "ready",
    browserApps: [browser],
  });
  const browserTitles = page.getByRole("checkbox", {
    name: "Record window titles in Native Browser",
  });
  await expect(browserTitles).not.toBeChecked();
  await expect(
    page.getByText(enMessages.activity.browserPrivacyNote, { exact: true }),
  ).toBeVisible();
  expect(await invocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "activity_set_browser_title_capture" }),
  );
  await browserTitles.check();
  await expect(browserTitles).toBeChecked();
  expect(await invocations(page)).toContainEqual({
    command: "activity_set_browser_title_capture",
    args: { identifier: browser.identifier, name: browser.name, enabled: true },
  });
  await browserTitles.uncheck();
  await expect(browserTitles).not.toBeChecked();
  expect(await invocations(page)).toContainEqual({
    command: "activity_set_browser_title_capture",
    args: {
      identifier: browser.identifier,
      name: browser.name,
      enabled: false,
    },
  });
});

for (const prerequisite of ["globalOff", "appNameOnly"] as const) {
  test(`browser title capture requires detail recording (${prerequisite})`, async ({
    page,
  }) => {
    const browser = {
      identifier: "native-classified.browser",
      name: "Native Browser",
    };
    await installNativeBoundary(page, {
      ...SNAPSHOT,
      captureDetails: prerequisite !== "globalOff",
      detailsAccess: prerequisite === "globalOff" ? "disabled" : "ready",
      browserApps: [browser],
      appNameOnlyApps: prerequisite === "appNameOnly" ? [browser] : [],
    });
    await expect(
      page.getByRole("checkbox", {
        name: "Record window titles in Native Browser",
      }),
    ).toBeDisabled();
    expect(await invocations(page)).not.toContainEqual(
      expect.objectContaining({
        command: "activity_set_browser_title_capture",
      }),
    );
  });
}

test("titles and document names render locally, with full paths only on hover and explicit copying", async ({
  page,
}) => {
  const document = "/private/synthetic/memo.docx";
  await installNativeBoundary(page, {
    ...SNAPSHOT,
    captureDetails: true,
    detailsAccess: "ready",
    segments: SNAPSHOT.segments.map((entry) => ({
      ...entry,
      document,
      windowTitle: "Synthetic title",
    })),
  });
  await expect(page.getByText("memo.docx", { exact: true })).toHaveCount(2);
  await expect(page.getByText(document, { exact: true })).toHaveCount(0);
  await expect(
    page.locator('[title="/private/synthetic/memo.docx"]'),
  ).toHaveCount(2);
  await expect(page.getByText("Synthetic title", { exact: true })).toHaveCount(
    2,
  );
  expect(await invocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "activity_copy_text" }),
  );
  await page
    .getByRole("button", { name: enMessages.activity.copySummary })
    .click();
  await expect(
    page.getByRole("button", { name: enMessages.activity.copied }),
  ).toBeVisible();
  expect(await invocations(page)).toContainEqual({
    command: "activity_copy_text",
    args: { text: expect.stringContaining("memo.docx") },
  });
  expect(await invocations(page)).not.toContainEqual({
    command: "activity_copy_text",
    args: { text: expect.stringContaining(document) },
  });
});

test("short activity stays in the timeline and total without a proposed block", async ({
  page,
}) => {
  await installNativeBoundary(page, {
    ...SNAPSHOT,
    segments: [
      {
        appIdentifier: "com.example.editor",
        appName: "Example Editor",
        start: "2026-10-07T09:00:00Z",
        end: "2026-10-07T09:02:59Z",
      },
    ],
  });
  await expect(
    page.getByRole("heading", {
      name: enMessages.activity.timeline,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: enMessages.activity.totalActive,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: enMessages.activity.proposedBlocks,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: enMessages.activity.copySummary }),
  ).toHaveCount(0);
});
