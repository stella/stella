import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import type {
  DesktopMatter,
  DesktopTimeEntryMatterCandidate,
} from "@stll/api-contract/desktop-time-entries";
import { setFixedBrowserTime } from "@stll/ui/browser-clock";

import {
  ACTIVITY_CHANGED_EVENT,
  isActivityDaySnapshot,
} from "../../src/activity/activity-types";
import type { ActivityDaySnapshot } from "../../src/activity/activity-types";
import previewApps from "../../src/activity/preview-apps.json" with { type: "json" };
import arMessages from "../../src/i18n/langs/ar.json" with { type: "json" };
import enMessages from "../../src/i18n/langs/en.json" with { type: "json" };
import { installTauriIpc, tauriInvocations } from "./tauri-ipc";
import type { TauriInvocation } from "./tauri-ipc";

const SNAPSHOT = {
  date: "2026-10-07",
  draftedEntries: [],
  manualAssignments: [],
  pendingBatch: null,
  deletionStatus: "available",
  timeBillingEnabled: true,
  earliestDate: "2026-10-01",
  latestDate: "2026-10-07",
  excludedApps: [],
  otherAccountHistoryDays: 0,
  captureDetails: false,
  detectCalls: true,
  appNameOnlyApps: [],
  browserApps: [],
  sourceAppVisuals: [],
  browserTitleApps: [],
  detailsAccess: "disabled",
  persistence: "encrypted",
  recordingStatus: "recording",
  retention: "month",
  segments: [
    {
      appIdentifier: "com.example.editor",
      appName: "Example Editor",
      matterId: "matter-1",
      start: "2026-10-07T09:00:00Z",
      end: "2026-10-07T09:30:00Z",
    },
  ],
  today: "2026-10-07",
  unreadable: false,
} satisfies ActivityDaySnapshot;

const PENDING_BATCH = {
  idempotencyKey: "stored-recovery-key",
  entries: [
    {
      matterId: "matter-1",
      dateWorked: SNAPSHOT.date,
      timezoneId: "Europe/Prague",
      durationMinutes: 30,
      narrative: "Stored confirmed narrative",
      billable: false,
    },
  ],
  ranges: [[{ start: "2026-10-07T09:00:00Z", end: "2026-10-07T09:30:00Z" }]],
} satisfies NonNullable<ActivityDaySnapshot["pendingBatch"]>;

type InstallNativeBoundaryOptions = {
  page: Page;
  snapshot?: ActivityDaySnapshot;
  additionalSnapshots?: ActivityDaySnapshot[];
  language?: "en" | "ar";
  batchValidation?: "accept" | "reject-first" | "hold-first";
  batchReceipt?: "save" | "fail-first" | "keep-pending";
  historyDeletion?:
    "available" | "keyMissing" | "unreadable" | "mixed" | "incompatible";
  /** How long the first paint may take; the default suits small fixtures. */
  firstRenderTimeoutMs?: number;
};

// timeout: A review of 101 matters with 101 timeline segments renders every
// row before its heading paints; on a loaded CI runner that has taken just over
// the 5 s expectation default.
const LARGE_REVIEW_FIRST_RENDER_TIMEOUT_MS = 15_000;

const installNativeBoundary = async ({
  page,
  snapshot = SNAPSHOT,
  additionalSnapshots = [],
  language = "en",
  batchValidation = "accept",
  batchReceipt = "save",
  historyDeletion = "available",
  firstRenderTimeoutMs,
}: InstallNativeBoundaryOptions) => {
  expect(isActivityDaySnapshot(snapshot)).toBe(true);
  await setFixedBrowserTime(page, new Date(`${snapshot.today}T10:00:00Z`));
  await installTauriIpc(page, {
    windowLabel: "activity",
    unhandled: "resolveUndefined",
    arg: {
      snapshot,
      additionalSnapshots,
      changedEvent: ACTIVITY_CHANGED_EVENT,
      language,
      batchValidation,
      batchReceipt,
      historyDeletion,
    },
    handlers: (
      {
        snapshot: initialSnapshot,
        additionalSnapshots: otherDays,
        changedEvent,
        language: desktopLanguage,
        batchValidation: validation,
        batchReceipt: receipt,
        historyDeletion: historyState,
      },
      { emit },
    ) => {
      let batchAttempts = 0;
      let activitySnapshot = initialSnapshot;
      const emitActivityChanged = () => emit(changedEvent, null);
      Reflect.set(
        window,
        "__STELLA_TEST_ACTIVITY_CHANGED__",
        emitActivityChanged,
      );
      Reflect.set(
        window,
        "__STELLA_TEST_SET_SNAPSHOT__",
        (next: typeof initialSnapshot) => {
          activitySnapshot = next;
          emitActivityChanged();
        },
      );
      return {
        activity_get_day: (args) => {
          const daySnapshot =
            otherDays.find((day) => day.date === args["date"]) ??
            activitySnapshot;
          return {
            ...daySnapshot,
            date: args["date"] ?? activitySnapshot.date,
          };
        },
        activity_delete_all: (args) => {
          if (
            args["recovery"] === "discardUnreadable" &&
            activitySnapshot.unreadable
          ) {
            activitySnapshot = {
              ...activitySnapshot,
              segments: [],
              pendingBatch: null,
              unreadable: false,
              deletionStatus: "available",
            };
            emitActivityChanged();
          }
          return undefined;
        },
        activity_delete_other_account_history: (args) => {
          if (
            args["recovery"] !== "preserve" &&
            args["recovery"] !== "discardUnrecoverable"
          ) {
            throw new TypeError("Unsupported history recovery mode");
          }
          if (historyState !== "available" && args["recovery"] === "preserve") {
            throw Object.assign(new Error("Activity history key is missing"), {
              type: historyState === "mixed" ? "keyMissing" : historyState,
            });
          }
          activitySnapshot = {
            ...activitySnapshot,
            otherAccountHistoryDays: 0,
          };
          emitActivityChanged();
          return undefined;
        },
        activity_set_capture_details: (args) => {
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
          return undefined;
        },
        activity_set_detect_calls: (args) => {
          const enabled = args["enabled"];
          if (typeof enabled !== "boolean") {
            throw new TypeError("Call choice must be explicit");
          }
          activitySnapshot = { ...activitySnapshot, detectCalls: enabled };
          emitActivityChanged();
          return undefined;
        },
        activity_set_app_detail_capture: (args) => {
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
          return undefined;
        },
        activity_set_browser_title_capture: (args) => {
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
          return undefined;
        },
        activity_set_recording_status: (args) => {
          if (args["status"] === "recording") {
            activitySnapshot = {
              ...activitySnapshot,
              recordingStatus: "recording",
            };
            emitActivityChanged();
          }
          return undefined;
        },
        time_entry_search_matters: () =>
          [
            {
              id: "matter-1",
              name: "Example matter",
              reference: "M-001",
              color: "--option-emerald",
            },
          ] satisfies DesktopMatter[],
        time_entry_candidates: () =>
          [
            {
              id: "matter-1",
              name: "Example matter",
              reference: "M-001",
              color: "--option-emerald",
              clientName: "Example client",
              signals: {
                lastWorkedAt: "2026-10-06",
                newlyAssignedAt: null,
                upcomingDeadline: null,
              },
            },
          ] satisfies DesktopTimeEntryMatterCandidate[],
        time_entry_discard_pending_batch_confirmed: (args) => {
          if (
            activitySnapshot.timeBillingEnabled ||
            activitySnapshot.pendingBatch?.idempotencyKey !==
              args["idempotencyKey"]
          ) {
            throw new TypeError("Pending discard is unavailable");
          }
          activitySnapshot = {
            ...activitySnapshot,
            pendingBatch: null,
            deletionStatus: "available",
          };
          emitActivityChanged();
          return undefined;
        },
        time_entry_submit_batch_confirmed: async () => {
          batchAttempts += 1;
          if (validation === "hold-first" && batchAttempts === 1) {
            return await new Promise((_resolve, reject) => {
              Reflect.set(window, "__STELLA_TEST_REJECT_BATCH__", () =>
                reject(
                  Object.assign(new Error("Response unavailable"), {
                    type: "uncertain",
                  }),
                ),
              );
            });
          }
          if (validation === "reject-first" && batchAttempts === 1) {
            throw Object.assign(new Error("Activity range validation failed"), {
              type: "rejected",
            });
          }
          const markerSaved = receipt !== "fail-first" || batchAttempts !== 1;
          if (
            markerSaved &&
            receipt !== "keep-pending" &&
            activitySnapshot.pendingBatch !== null
          ) {
            activitySnapshot = {
              ...activitySnapshot,
              pendingBatch: null,
              deletionStatus: "available",
            };
            emitActivityChanged();
          }
          return {
            entries: [{ id: "draft-1", matterId: "matter-1" }],
            markerSaved,
          };
        },
        get_desktop_language: () => desktopLanguage,
      };
    },
  });
  await page.goto("/");
  const messages = language === "ar" ? arMessages : enMessages;
  if (snapshot.persistence === "deletionOnly") {
    await expect(
      page.getByText(
        {
          keyMissing: messages.activity.deletionOnly,
          unreadable: messages.activity.unreadableEraseNotice,
          available: messages.activity.errorRead,
          pending: messages.activity.errorRead,
          unavailable: messages.activity.errorRead,
          incompatible: messages.activity.incompatibleActivity,
        }[snapshot.deletionStatus],
      ),
    ).toBeVisible();
  } else if (
    snapshot.recordingStatus === "off" &&
    snapshot.pendingBatch === null &&
    snapshot.deletionStatus !== "pending"
  ) {
    await expect(
      page.getByRole("heading", {
        name: messages.activity.welcomeTitle,
        exact: true,
      }),
    ).toBeVisible();
  } else {
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible(
      firstRenderTimeoutMs === undefined
        ? {}
        : { timeout: firstRenderTimeoutMs },
    );
  }
  if (
    (snapshot.recordingStatus !== "off" ||
      snapshot.pendingBatch !== null ||
      snapshot.deletionStatus === "pending") &&
    snapshot.persistence !== "deletionOnly"
  ) {
    await page
      .locator("summary")
      .filter({ hasText: messages.activity.settings })
      .click();
  }
};

for (const history of ["keep", "delete"] as const) {
  test(`excluding an app waits for the ${history} history choice`, async ({
    page,
  }) => {
    await installNativeBoundary({ page });
    await page
      .getByRole("button", { name: "Stop recording Example Editor" })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await tauriInvocations(page)).not.toContainEqual(
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
    expect(await tauriInvocations(page)).toContainEqual({
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
  await installNativeBoundary({ page });
  await page
    .getByRole("button", { name: "Stop recording Example Editor" })
    .click();
  await page.getByRole("button", { name: enMessages.activity.cancel }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(await tauriInvocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "activity_exclude_app" }),
  );
});

for (const language of ["en", "ar"] as const) {
  test(`${language}: timeline segment click selects its range without treating jitter as a drag`, async ({
    page,
  }) => {
    await installNativeBoundary({ page, language });
    const messages = language === "ar" ? arMessages : enMessages;
    const start = page.getByRole("group", {
      name: messages.activity.rangeStart,
      exact: true,
    });
    const end = page.getByRole("group", {
      name: messages.activity.rangeEnd,
      exact: true,
    });
    const segment = page.locator("button[data-activity-segment]").first();
    const sample = SNAPSHOT.segments.at(0);
    if (!sample) {
      throw new TypeError("Timeline fixture must contain a segment");
    }
    const expected = await page.evaluate(
      ({ start: segmentStart, end: segmentEnd }) =>
        [segmentStart, segmentEnd].map((instant) => {
          const value = new Date(instant);
          return [value.getHours(), value.getMinutes()];
        }),
      sample,
    );
    await expect(start).toHaveCount(0);
    await segment.click();
    await expect(start).toBeVisible();
    await expect(end).toBeVisible();
    await expect(start.getByRole("spinbutton").nth(0)).toHaveValue(
      String(expected.at(0)?.at(0)),
    );
    await expect(start.getByRole("spinbutton").nth(1)).toHaveValue(
      String(expected.at(0)?.at(1)),
    );
    await expect(end.getByRole("spinbutton").nth(0)).toHaveValue(
      String(expected.at(1)?.at(0)),
    );
    await expect(end.getByRole("spinbutton").nth(1)).toHaveValue(
      String(expected.at(1)?.at(1)),
    );
    await page
      .getByRole("button", { name: messages.activity.cancel, exact: true })
      .click();
    await segment.scrollIntoViewIfNeeded();
    const box = await segment.boundingBox();
    if (!box) {
      throw new TypeError("Timeline segment must have bounds");
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2);
    await page.mouse.up();
    await expect(start).toBeVisible();
    await expect(start.getByRole("spinbutton").nth(1)).toHaveValue(
      String(expected.at(0)?.at(1)),
    );
    await expect(end.getByRole("spinbutton").nth(1)).toHaveValue(
      String(expected.at(1)?.at(1)),
    );
  });

  test(`${language}: timeline segment drag selects a subrange and keeps keyboard selection available`, async ({
    page,
  }) => {
    await installNativeBoundary({ page, language });
    const messages = language === "ar" ? arMessages : enMessages;
    const segment = page.locator("button[data-activity-segment]").first();
    await segment.scrollIntoViewIfNeeded();
    const box = await segment.boundingBox();
    if (!box) {
      throw new TypeError("Timeline segment must have bounds");
    }
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, {
      steps: 6,
    });
    await page.mouse.up();
    const start = page.getByRole("group", {
      name: messages.activity.rangeStart,
      exact: true,
    });
    const end = page.getByRole("group", {
      name: messages.activity.rangeEnd,
      exact: true,
    });
    await expect(start).toBeVisible();
    await expect(end).toBeVisible();
    const selectedStart =
      Number(await start.getByRole("spinbutton").nth(0).inputValue()) * 60 +
      Number(await start.getByRole("spinbutton").nth(1).inputValue());
    const selectedEnd =
      Number(await end.getByRole("spinbutton").nth(0).inputValue()) * 60 +
      Number(await end.getByRole("spinbutton").nth(1).inputValue());
    expect(selectedEnd - selectedStart).toBeGreaterThan(0);
    expect(selectedEnd - selectedStart).toBeLessThan(30);
    await segment.focus();
    await segment.press("Enter");
    const keyboardStart =
      Number(await start.getByRole("spinbutton").nth(0).inputValue()) * 60 +
      Number(await start.getByRole("spinbutton").nth(1).inputValue());
    const keyboardEnd =
      Number(await end.getByRole("spinbutton").nth(0).inputValue()) * 60 +
      Number(await end.getByRole("spinbutton").nth(1).inputValue());
    expect(keyboardEnd - keyboardStart).toBe(30);
  });
}

test("only explicit batch creation sends the edited billing fields and prevents recreation", async ({
  page,
}) => {
  await installNativeBoundary({ page });
  // A confident match needs no badge; only a likely one asks for a look.
  await expect(
    page.getByText(enMessages.activity.strongMatch, { exact: true }),
  ).toHaveCount(0);
  const narrative = page.getByRole("textbox", {
    name: enMessages.activity.entryNarrative,
  });
  await expect(narrative).toHaveValue("Work in Example Editor");
  await expect(
    page.getByRole("switch", { name: enMessages.activity.entryBillable }),
  ).toBeChecked();
  const include = page.getByRole("checkbox", {
    name: "Include Example matter",
  });
  await include.uncheck();
  await expect(
    page.getByRole("button", { name: "Create 0 drafts", exact: true }),
  ).toBeDisabled();
  await include.check();
  await narrative.fill("Draft-only confidential narrative 71f3");
  const callsBefore = await tauriInvocations(page);
  expect(callsBefore).not.toContainEqual(
    expect.objectContaining({ command: "time_entry_submit_batch_confirmed" }),
  );
  expect(callsBefore).not.toContainEqual(
    expect.objectContaining({ command: "activity_copy_text" }),
  );
  await page
    .getByRole("button", { name: "Create 1 draft", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("1 draft created");
  const timezoneId = await page.evaluate(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const calls = await tauriInvocations(page);
  expect(calls).toContainEqual({
    command: "time_entry_submit_batch_confirmed",
    args: {
      request: {
        date: "2026-10-07",
        idempotencyKey: expect.any(String),
        items: [
          {
            entry: {
              matterId: "matter-1",
              dateWorked: "2026-10-07",
              timezoneId,
              durationMinutes: 30,
              narrative: "Draft-only confidential narrative 71f3",
              billable: true,
            },
            ranges: [
              { start: "2026-10-07T09:00:00Z", end: "2026-10-07T09:30:00Z" },
            ],
          },
        ],
      },
    },
  });
  // The local native boundary receives receipts, without app identities or raw segments.
  const submissions = calls.filter(
    ({ command }) => command === "time_entry_submit_batch_confirmed",
  );
  expect(submissions).toHaveLength(1);
  expect(JSON.stringify(submissions)).not.toContain("Example Editor");
  expect(JSON.stringify(submissions)).not.toContain("appIdentifier");
  expect(JSON.stringify(submissions)).not.toContain("windowTitle");
  expect(JSON.stringify(submissions)).not.toContain('"segments"');
  await expect(
    page.getByRole("button", { name: "Create 0 drafts", exact: true }),
  ).toBeDisabled();
});

test("more than 100 selected matters keep the review editable until the selection is reduced", async ({
  page,
}) => {
  const startMs = Date.parse("2026-10-07T09:00:00Z");
  const manualAssignments = Array.from({ length: 101 }, (_, index) => ({
    start: new Date(startMs + index * 60_000).toISOString(),
    end: new Date(startMs + (index + 1) * 60_000).toISOString(),
    matterId: `manual-matter-${index}`,
    matter: {
      id: `manual-matter-${index}`,
      name: `Manual matter ${index}`,
      reference: null,
      color: null,
      clientName: null,
    },
  }));
  await installNativeBoundary({
    page,
    firstRenderTimeoutMs: LARGE_REVIEW_FIRST_RENDER_TIMEOUT_MS,
    snapshot: {
      ...SNAPSHOT,
      manualAssignments,
      segments: [
        {
          appIdentifier: "com.example.editor",
          appName: "Example Editor",
          start: "2026-10-07T09:00:00Z",
          end: "2026-10-07T10:41:00Z",
        },
      ],
    },
  });
  const includes = page.getByRole("checkbox", {
    name: /^Include Manual matter /u,
  });
  await expect(includes).toHaveCount(101);
  await expect(
    page.getByRole("button", { name: "Create 101 drafts", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText(
    enMessages.activity.batchLimitExceeded.replace("{limit}", "100"),
  );
  expect(await tauriInvocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "time_entry_submit_batch_confirmed" }),
  );
  const include = page.getByRole("checkbox", {
    name: "Include Manual matter 0",
    exact: true,
  });
  await expect(include).toBeEnabled();
  await expect(
    page
      .getByRole("textbox", { name: enMessages.activity.entryNarrative })
      .first(),
  ).toBeEnabled();
  await include.uncheck();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create 100 drafts", exact: true }),
  ).toBeEnabled();
  await include.check();
  await expect(
    page.getByRole("button", { name: "Create 101 drafts", exact: true }),
  ).toBeDisabled();
});

test("native validation rejection leaves the review editable and a corrected selection uses a new batch key", async ({
  page,
}) => {
  const finalStart = "2026-10-07T09:30:00Z";
  const finalEnd = "2026-10-07T09:36:00Z";
  await installNativeBoundary({
    page,
    batchValidation: "reject-first",
    snapshot: {
      ...SNAPSHOT,
      segments: [
        ...SNAPSHOT.segments,
        {
          appIdentifier: "com.example.editor",
          appName: "Example Editor",
          matterId: "corrected-matter",
          start: finalStart,
          end: finalEnd,
        },
      ],
      manualAssignments: [
        {
          start: finalStart,
          end: finalEnd,
          matterId: "corrected-matter",
          matter: {
            id: "corrected-matter",
            name: "Corrected matter",
            reference: null,
            color: null,
            clientName: null,
          },
        },
      ],
    },
  });
  await page
    .getByRole("button", { name: "Create 2 drafts", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    enMessages.activity.batchFailed,
  );
  const include = page.getByRole("checkbox", {
    name: "Include Example matter",
    exact: true,
  });
  await expect(include).toBeEnabled();
  await expect(
    page
      .getByRole("textbox", { name: enMessages.activity.entryNarrative })
      .first(),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", {
      name: enMessages.activity.pendingRetry,
      exact: true,
    }),
  ).toHaveCount(0);
  await include.uncheck();
  await page
    .getByRole("button", { name: "Create 1 draft", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("1 draft created");
  const submitted = (await tauriInvocations(page)).flatMap(
    ({ args, command }) => {
      if (command !== "time_entry_submit_batch_confirmed") {
        return [];
      }
      const request = args["request"];
      if (
        typeof request !== "object" ||
        request === null ||
        !("idempotencyKey" in request) ||
        typeof request.idempotencyKey !== "string" ||
        !("items" in request) ||
        !Array.isArray(request.items)
      ) {
        throw new TypeError("Batch request is missing");
      }
      return [
        {
          key: request.idempotencyKey,
          matterIds: request.items.map((item: unknown) => {
            if (
              typeof item !== "object" ||
              item === null ||
              !("entry" in item) ||
              typeof item.entry !== "object" ||
              item.entry === null ||
              !("matterId" in item.entry) ||
              typeof item.entry.matterId !== "string"
            ) {
              throw new TypeError("Batch entry is missing");
            }
            return item.entry.matterId;
          }),
        },
      ];
    },
  );
  expect(submitted).toHaveLength(2);
  expect(submitted.at(0)?.matterIds).toEqual(["matter-1", "corrected-matter"]);
  expect(submitted.at(1)?.matterIds).toEqual(["corrected-matter"]);
  expect(submitted.at(1)?.key).not.toBe(submitted.at(0)?.key);
});

test("unresolved draft creation protects activity deletion and retains its batch key", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    batchValidation: "hold-first",
    snapshot: { ...SNAPSHOT, otherAccountHistoryDays: 1 },
  });
  await page
    .getByRole("button", { name: "Create 1 draft", exact: true })
    .click();
  for (const name of [
    enMessages.activity.deleteDay,
    enMessages.activity.deleteAll,
    enMessages.activity.deleteOtherAccountHistory,
  ]) {
    await expect(
      page.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  }
  await expect(
    page.getByRole("button", { name: enMessages.activity.previousDay }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: enMessages.activity.excludeApp.replace("{name}", "Example Editor"),
    }),
  ).toBeDisabled();
  await page.evaluate(() => {
    const changed = Reflect.get(window, "__STELLA_TEST_ACTIVITY_CHANGED__");
    const reject = Reflect.get(window, "__STELLA_TEST_REJECT_BATCH__");
    if (typeof changed !== "function" || typeof reject !== "function") {
      throw new TypeError("Native recovery controls are missing");
    }
    changed();
    reject();
  });
  const retry = page.getByRole("button", {
    name: enMessages.activity.pendingRetry,
    exact: true,
  });
  await expect(retry).toBeEnabled();
  await expect(
    page.getByRole("button", {
      name: enMessages.activity.deleteDay,
      exact: true,
    }),
  ).toBeDisabled();
  const before = await tauriInvocations(page);
  await retry.click();
  await expect(page.getByRole("status")).toContainText("1 draft created");
  const after = await tauriInvocations(page);
  const submissions = (calls: TauriInvocation[]) =>
    calls.filter(
      ({ command }) => command === "time_entry_submit_batch_confirmed",
    );
  expect(submissions(before)).toHaveLength(1);
  expect(submissions(after)).toHaveLength(2);
  expect(submissions(after).at(0)).toEqual(submissions(after).at(1));
  for (const command of [
    "activity_delete_day",
    "activity_delete_all",
    "activity_delete_other_account_history",
    "activity_exclude_app",
  ]) {
    expect(after).not.toContainEqual(expect.objectContaining({ command }));
  }
});

for (const recoveryState of ["empty", "unreadable", "off"] as const) {
  test(`stored pending drafts can be retried from ${recoveryState} activity`, async ({
    page,
  }) => {
    const entry = {
      matterId: "matter-1",
      dateWorked: SNAPSHOT.date,
      timezoneId: "Europe/Prague",
      durationMinutes: 30,
      narrative: "Stored confirmed narrative",
      billable: false,
    };
    const ranges = [
      { start: "2026-10-07T09:00:00Z", end: "2026-10-07T09:30:00Z" },
    ];
    await installNativeBoundary({
      page,
      snapshot: {
        ...SNAPSHOT,
        segments: [],
        unreadable: recoveryState === "unreadable",
        recordingStatus: recoveryState === "off" ? "off" : "recording",
        pendingBatch: {
          idempotencyKey: "stored-recovery-key",
          entries: [entry],
          ranges: [ranges],
        },
      },
    });
    await page
      .getByRole("button", {
        name: enMessages.activity.pendingRetry,
        exact: true,
      })
      .click();
    await expect(page.getByRole("status")).toContainText("1 draft created");
    expect(await tauriInvocations(page)).toContainEqual({
      command: "time_entry_submit_batch_confirmed",
      args: {
        request: {
          date: SNAPSHOT.date,
          idempotencyKey: "stored-recovery-key",
          items: [{ entry, ranges }],
        },
      },
    });
  });
}

for (const recordingStatus of ["recording", "off"] as const) {
  test(`pending drafts on another day protect deletion while ${recordingStatus} and permit recovery navigation`, async ({
    page,
  }) => {
    await installNativeBoundary({
      page,
      snapshot: {
        ...SNAPSHOT,
        segments: [],
        recordingStatus,
        deletionStatus: "pending",
      },
    });
    await expect(
      page.getByRole("button", {
        name: enMessages.activity.deleteAll,
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: enMessages.activity.previousDay }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: enMessages.activity.previousDay })
      .click();
    expect(await tauriInvocations(page)).toContainEqual({
      command: "activity_get_day",
      args: { date: "2026-10-06" },
    });
  });
}

test("stored pending drafts stay immutable after a rejected retry until cancellation is confirmed", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    batchValidation: "reject-first",
    snapshot: {
      ...SNAPSHOT,
      pendingBatch: PENDING_BATCH,
      deletionStatus: "pending",
    },
  });
  const retry = page.getByRole("button", {
    name: enMessages.activity.pendingRetry,
    exact: true,
  });
  await retry.click();
  await expect(page.getByRole("alert")).toContainText(
    enMessages.activity.batchFailed,
  );
  await expect(retry).toBeEnabled();
  await expect(
    page.getByRole("checkbox", { name: "Include Example matter", exact: true }),
  ).toBeDisabled();
  await page.evaluate((next) => {
    const update = Reflect.get(window, "__STELLA_TEST_SET_SNAPSHOT__");
    if (typeof update !== "function") {
      throw new TypeError("Snapshot control is missing");
    }
    update(next);
  }, SNAPSHOT);
  await expect(retry).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: "Include Example matter", exact: true }),
  ).toBeEnabled();
});

test("unreadable saved activity explains why deletion is unavailable", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: {
      ...SNAPSHOT,
      persistence: "deletionOnly",
      recordingStatus: "off",
      deletionStatus: "unavailable",
      otherAccountHistoryDays: 3,
    },
  });
  await expect(
    page.getByText(enMessages.activity.errorRead, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: enMessages.activity.deleteAll,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: enMessages.activity.deleteOtherAccountHistory,
      exact: true,
    }),
  ).toBeDisabled();
});

test("stored pending drafts remain visible without billing capability and cannot be submitted", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: {
      ...SNAPSHOT,
      segments: [],
      pendingBatch: PENDING_BATCH,
      timeBillingEnabled: false,
      deletionStatus: "pending",
    },
  });
  await expect(
    page.getByRole("button", {
      name: enMessages.activity.pendingRetry,
      exact: true,
    }),
  ).toBeDisabled();
  await expect(page.getByRole("status")).toContainText(
    enMessages.activity.batchUnavailable,
  );
  expect(await tauriInvocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "time_entry_submit_batch_confirmed" }),
  );
  await expect(
    page.getByRole("button", { name: enMessages.activity.previousDay }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: enMessages.activity.previousDay })
    .click();
  expect(await tauriInvocations(page)).toContainEqual({
    command: "activity_get_day",
    args: { date: "2026-10-06" },
  });
});

test("empty recovery keeps its saved receipt visible until navigating to another day", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: {
      ...SNAPSHOT,
      segments: [],
      pendingBatch: PENDING_BATCH,
      deletionStatus: "pending",
    },
  });
  await page
    .getByRole("button", {
      name: enMessages.activity.pendingRetry,
      exact: true,
    })
    .click();
  await expect(page.getByRole("status")).toContainText("1 draft created");
  await expect(
    page.getByRole("button", {
      name: enMessages.activity.pendingRetry,
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: enMessages.activity.previousDay })
    .click();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(
    page.getByText(enMessages.activity.empty, { exact: true }),
  ).toBeVisible();
});

test("a saved draft receipt remains saved while its snapshot refresh is pending", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    batchReceipt: "keep-pending",
    snapshot: {
      ...SNAPSHOT,
      pendingBatch: PENDING_BATCH,
      deletionStatus: "pending",
    },
  });
  await page
    .getByRole("button", {
      name: enMessages.activity.pendingRetry,
      exact: true,
    })
    .click();
  await expect(page.getByRole("status")).toContainText("1 draft created");
  await expect(
    page.getByRole("button", {
      name: enMessages.activity.pendingRetry,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: enMessages.activity.previousDay }),
  ).toBeEnabled();
});

test("a failed draft receipt remains retryable with the same stored batch key", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    batchReceipt: "fail-first",
    snapshot: {
      ...SNAPSHOT,
      pendingBatch: PENDING_BATCH,
      deletionStatus: "pending",
    },
  });
  const retry = page.getByRole("button", {
    name: enMessages.activity.pendingRetry,
    exact: true,
  });
  await retry.click();
  await expect(page.getByRole("alert")).toContainText(
    enMessages.activity.draftMarkerFailed,
  );
  await expect(retry).toBeEnabled();
  await expect(
    page.getByRole("button", { name: enMessages.activity.previousDay }),
  ).toBeEnabled();
  await retry.click();
  await expect(page.getByRole("status")).toContainText("1 draft created");
  const calls = await tauriInvocations(page);
  const expected = {
    command: "time_entry_submit_batch_confirmed",
    args: {
      request: {
        date: SNAPSHOT.date,
        idempotencyKey: PENDING_BATCH.idempotencyKey,
        items: [
          { entry: PENDING_BATCH.entries[0], ranges: PENDING_BATCH.ranges[0] },
        ],
      },
    },
  };
  expect(
    calls.filter(
      ({ command }) => command === "time_entry_submit_batch_confirmed",
    ),
  ).toEqual([expected, expected]);
});

for (const currentKeyStatus of ["available", "keyMissing"] as const) {
  test(`inactive missing-key history requires confirmation with current key ${currentKeyStatus}`, async ({
    page,
  }) => {
    await installNativeBoundary({
      page,
      historyDeletion: "keyMissing",
      snapshot: {
        ...SNAPSHOT,
        otherAccountHistoryDays: 3,
        deletionStatus: currentKeyStatus,
        persistence:
          currentKeyStatus === "keyMissing" ? "deletionOnly" : "encrypted",
      },
    });
    await page
      .getByRole("button", {
        name: enMessages.activity.deleteOtherAccountHistory,
        exact: true,
      })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: enMessages.activity.delete, exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      enMessages.activity.unrecoverableOtherHistoryConfirmation,
    );
    expect(await tauriInvocations(page)).toContainEqual({
      command: "activity_delete_other_account_history",
      args: { recovery: "preserve" },
    });
    expect(await tauriInvocations(page)).not.toContainEqual(
      expect.objectContaining({ command: "activity_delete_all" }),
    );
    expect(await tauriInvocations(page)).not.toContainEqual({
      command: "activity_delete_other_account_history",
      args: { recovery: "discardUnrecoverable" },
    });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: enMessages.activity.delete, exact: true })
      .click();
    expect(await tauriInvocations(page)).toContainEqual({
      command: "activity_delete_other_account_history",
      args: { recovery: "discardUnrecoverable" },
    });
  });
}

test("billing-disabled pending recovery can be discarded locally only after confirmation", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: {
      ...SNAPSHOT,
      segments: [],
      pendingBatch: PENDING_BATCH,
      timeBillingEnabled: false,
      deletionStatus: "pending",
    },
  });
  const discard = page.getByRole("button", {
    name: enMessages.activity.discardPendingRecovery,
    exact: true,
  });
  await discard.click();
  await expect(page.getByRole("dialog")).toContainText(
    enMessages.activity.discardPendingConfirmation,
  );
  expect(await tauriInvocations(page)).not.toContainEqual(
    expect.objectContaining({
      command: "time_entry_discard_pending_batch_confirmed",
    }),
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: enMessages.activity.cancel, exact: true })
    .click();
  await expect(discard).toBeVisible();
  await discard.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: enMessages.activity.delete, exact: true })
    .click();
  await expect(
    page.getByText(enMessages.activity.empty, { exact: true }),
  ).toBeVisible();
  expect(await tauriInvocations(page)).toContainEqual({
    command: "time_entry_discard_pending_batch_confirmed",
    args: { date: SNAPSHOT.date, idempotencyKey: PENDING_BATCH.idempotencyKey },
  });
  expect(await tauriInvocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "time_entry_submit_batch_confirmed" }),
  );
});

test("pending drafts dated after today remain reachable after the clock moves backward", async ({
  page,
}) => {
  const futureDate = "2026-10-08";
  await installNativeBoundary({
    page,
    snapshot: {
      ...SNAPSHOT,
      segments: [],
      latestDate: futureDate,
      deletionStatus: "pending",
    },
    additionalSnapshots: [
      {
        ...SNAPSHOT,
        date: futureDate,
        latestDate: futureDate,
        segments: [],
        deletionStatus: "pending",
        pendingBatch: {
          ...PENDING_BATCH,
          entries: PENDING_BATCH.entries.map((entry) => ({
            ...entry,
            dateWorked: futureDate,
          })),
        },
      },
    ],
  });
  const next = page.getByRole("button", { name: enMessages.activity.nextDay });
  await expect(next).toBeEnabled();
  await next.click();
  await expect(
    page.getByRole("button", {
      name: enMessages.activity.pendingRetry,
      exact: true,
    }),
  ).toBeEnabled();
  expect(await tauriInvocations(page)).toContainEqual({
    command: "activity_get_day",
    args: { date: futureDate },
  });
  await expect(next).toBeDisabled();
});

test("discarding an old recovery key cannot unlock a later uncertain batch", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    batchValidation: "hold-first",
    snapshot: {
      ...SNAPSHOT,
      pendingBatch: PENDING_BATCH,
      timeBillingEnabled: false,
      deletionStatus: "pending",
    },
  });
  await page
    .getByRole("button", {
      name: enMessages.activity.discardPendingRecovery,
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: enMessages.activity.delete, exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: enMessages.activity.pendingRetry,
      exact: true,
    }),
  ).toHaveCount(0);
  await page.evaluate((next) => {
    const update = Reflect.get(window, "__STELLA_TEST_SET_SNAPSHOT__");
    if (typeof update !== "function") {
      throw new TypeError("Snapshot control is missing");
    }
    update(next);
  }, SNAPSHOT);
  await page
    .getByRole("button", { name: "Create 1 draft", exact: true })
    .click();
  await page.evaluate(() => {
    const reject = Reflect.get(window, "__STELLA_TEST_REJECT_BATCH__");
    if (typeof reject !== "function") {
      throw new TypeError("Pending batch control is missing");
    }
    reject();
  });
  await expect(page.getByRole("alert")).toContainText(
    enMessages.activity.batchFailed,
  );
  await expect(
    page.getByRole("button", {
      name: enMessages.activity.pendingRetry,
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    page.getByRole("checkbox", { name: "Include Example matter", exact: true }),
  ).toBeDisabled();
  expect(await tauriInvocations(page)).toContainEqual(
    expect.objectContaining({
      command: "time_entry_submit_batch_confirmed",
      args: expect.objectContaining({
        request: expect.objectContaining({
          idempotencyKey: expect.not.stringContaining(
            PENDING_BATCH.idempotencyKey,
          ),
        }),
      }),
    }),
  );
});

test("pending discard confirmation becomes unavailable when billing capability returns", async ({
  page,
}) => {
  const snapshot = {
    ...SNAPSHOT,
    pendingBatch: PENDING_BATCH,
    timeBillingEnabled: false,
    deletionStatus: "pending",
  } satisfies ActivityDaySnapshot;
  await installNativeBoundary({ page, snapshot });
  await page
    .getByRole("button", {
      name: enMessages.activity.discardPendingRecovery,
      exact: true,
    })
    .click();
  await page.evaluate(
    (next) => {
      const update = Reflect.get(window, "__STELLA_TEST_SET_SNAPSHOT__");
      if (typeof update !== "function") {
        throw new TypeError("Snapshot control is missing");
      }
      update(next);
    },
    { ...snapshot, timeBillingEnabled: true },
  );
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: enMessages.activity.delete, exact: true }),
  ).toBeDisabled();
  expect(await tauriInvocations(page)).not.toContainEqual(
    expect.objectContaining({
      command: "time_entry_discard_pending_batch_confirmed",
    }),
  );
});

test("stored pending retry permits confirmed unreadable repair while ordinary deletion stays blocked", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: {
      ...SNAPSHOT,
      segments: [],
      pendingBatch: PENDING_BATCH,
      timeBillingEnabled: false,
      unreadable: true,
      deletionStatus: "unreadable",
    },
  });
  await expect(
    page.getByRole("button", {
      name: enMessages.activity.discardPendingRecovery,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: enMessages.activity.deleteDay,
      exact: true,
    }),
  ).toBeDisabled();
  const repair = page.getByRole("button", {
    name: enMessages.activity.unreadableEraseAction,
    exact: true,
  });
  await expect(repair).toBeEnabled();
  await repair.click();
  await expect(page.getByRole("dialog")).toContainText(
    enMessages.activity.unreadableEraseConfirmation,
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: enMessages.activity.delete, exact: true })
    .click();
  await expect(
    page.getByText(enMessages.activity.empty, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: enMessages.activity.pendingRetry,
      exact: true,
    }),
  ).toHaveCount(0);
  expect(await tauriInvocations(page)).toContainEqual({
    command: "activity_delete_all",
    args: { recovery: "discardUnreadable" },
  });
  expect(await tauriInvocations(page)).not.toContainEqual(
    expect.objectContaining({
      command: "time_entry_discard_pending_batch_confirmed",
    }),
  );
});

test("unreadable activity erase requires confirmation of lost pending recovery", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: { ...SNAPSHOT, unreadable: true, deletionStatus: "unreadable" },
  });
  await page
    .getByRole("button", {
      name: enMessages.activity.unreadableEraseAction,
      exact: true,
    })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    enMessages.activity.unreadableEraseConfirmation,
  );
  expect(await tauriInvocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "activity_delete_all" }),
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: enMessages.activity.delete, exact: true })
    .click();
  expect(await tauriInvocations(page)).toContainEqual({
    command: "activity_delete_all",
    args: { recovery: "discardUnreadable" },
  });
});

test("inactive unreadable history reaches its dedicated confirmed recovery path", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    historyDeletion: "unreadable",
    snapshot: { ...SNAPSHOT, otherAccountHistoryDays: 3 },
  });
  await page
    .getByRole("button", {
      name: enMessages.activity.deleteOtherAccountHistory,
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: enMessages.activity.delete, exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    enMessages.activity.unrecoverableOtherHistoryConfirmation,
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: enMessages.activity.delete, exact: true })
    .click();
  expect(await tauriInvocations(page)).toContainEqual({
    command: "activity_delete_other_account_history",
    args: { recovery: "discardUnrecoverable" },
  });
});

test("mixed inactive recovery failures use one confirmation and one discard mode", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    historyDeletion: "mixed",
    snapshot: { ...SNAPSHOT, otherAccountHistoryDays: 3 },
  });
  await page
    .getByRole("button", {
      name: enMessages.activity.deleteOtherAccountHistory,
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: enMessages.activity.delete, exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    enMessages.activity.unrecoverableOtherHistoryConfirmation,
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: enMessages.activity.delete, exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    (await tauriInvocations(page)).filter(
      ({ command }) => command === "activity_delete_other_account_history",
    ),
  ).toEqual([
    {
      command: "activity_delete_other_account_history",
      args: { recovery: "preserve" },
    },
    {
      command: "activity_delete_other_account_history",
      args: { recovery: "discardUnrecoverable" },
    },
  ]);
});

test("incompatible saved activity asks for an app update and exposes no erase action", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: {
      ...SNAPSHOT,
      persistence: "deletionOnly",
      recordingStatus: "off",
      deletionStatus: "incompatible",
    },
  });
  await expect(
    page.getByText(enMessages.activity.incompatibleActivity, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: enMessages.activity.deleteAll,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: enMessages.activity.unreadableEraseAction,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("healthy current activity shows incompatible history guidance and protects deletion", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: {
      ...SNAPSHOT,
      deletionStatus: "incompatible",
      otherAccountHistoryDays: 3,
    },
  });
  await expect(
    page.getByText(enMessages.activity.incompatibleActivity, { exact: true }),
  ).toBeVisible();
  for (const name of [
    enMessages.activity.deleteDay,
    enMessages.activity.deleteAll,
    enMessages.activity.deleteOtherAccountHistory,
  ]) {
    await expect(
      page.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  }
  await expect(
    page.getByRole("button", {
      name: enMessages.activity.unreadableEraseAction,
      exact: true,
    }),
  ).toHaveCount(0);
});

test("an open erase dialog disappears safely when saved history becomes incompatible", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installNativeBoundary({ page });
  await page
    .getByRole("button", { name: enMessages.activity.deleteDay, exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.evaluate(
    (next) => {
      const update = Reflect.get(window, "__STELLA_TEST_SET_SNAPSHOT__");
      if (typeof update !== "function") {
        throw new TypeError("Snapshot control is missing");
      }
      update(next);
    },
    { ...SNAPSHOT, deletionStatus: "incompatible" },
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByText(enMessages.activity.incompatibleActivity, { exact: true }),
  ).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(await tauriInvocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "activity_delete_day" }),
  );
});

test("inactive incompatible history closes consent and requests an app update", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    historyDeletion: "incompatible",
    snapshot: { ...SNAPSHOT, otherAccountHistoryDays: 3 },
  });
  await page
    .getByRole("button", {
      name: enMessages.activity.deleteOtherAccountHistory,
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: enMessages.activity.delete, exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText(
    enMessages.activity.incompatibleActivity,
  );
  expect(await tauriInvocations(page)).not.toContainEqual({
    command: "activity_delete_other_account_history",
    args: { recovery: "discardUnrecoverable" },
  });
});

test("missing-key erase requires explicit confirmation that draft recovery will be lost", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: {
      ...SNAPSHOT,
      persistence: "deletionOnly",
      recordingStatus: "off",
      deletionStatus: "keyMissing",
    },
  });
  await page
    .getByRole("button", { name: enMessages.activity.deleteAll, exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    enMessages.activity.missingKeyEraseConfirmation,
  );
  expect(await tauriInvocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "activity_delete_all" }),
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: enMessages.activity.delete, exact: true })
    .click();
  expect(await tauriInvocations(page)).toContainEqual({
    command: "activity_delete_all",
    args: { recovery: "discardMissingKey" },
  });
});

test("only an explicit summary copy publishes activity to the clipboard", async ({
  page,
}) => {
  await installNativeBoundary({ page });
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
  const callsBeforeCopy = await tauriInvocations(page);
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
  const callsAfterCopy = await tauriInvocations(page);
  expect(callsAfterCopy).toContainEqual({
    command: "activity_copy_text",
    args: { text: expect.stringContaining("Example Editor") },
  });
  expect(
    callsAfterCopy.filter(({ command }) => command === "activity_copy_text"),
  ).toHaveLength(1);
});

for (const state of [
  { persistence: "encrypted", recordingStatus: "recording" },
  { persistence: "encrypted", recordingStatus: "off" },
] as const) {
  test(`other-account history is count-only and deletion is confirmed in ${state.persistence}/${state.recordingStatus}`, async ({
    page,
  }) => {
    await installNativeBoundary({
      page,
      snapshot: {
        ...SNAPSHOT,
        ...state,
        otherAccountHistoryDays: 3,
      },
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
    expect(await tauriInvocations(page)).not.toContainEqual(
      expect.objectContaining({
        command: "activity_delete_other_account_history",
      }),
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: enMessages.activity.cancel, exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(await tauriInvocations(page)).not.toContainEqual(
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
    expect(await tauriInvocations(page)).toContainEqual({
      command: "activity_delete_other_account_history",
      args: { recovery: "preserve" },
    });
  });
}

test("no other-account history note is shown when its day count is zero", async ({
  page,
}) => {
  await installNativeBoundary({ page });
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
  await installNativeBoundary({
    page,
    snapshot: { ...SNAPSHOT, recordingStatus: "off" },
  });
  const details = page.getByRole("checkbox", {
    name: enMessages.activity.captureDetails,
  });
  await expect(details).not.toBeChecked();
  expect(await tauriInvocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "activity_set_capture_details" }),
  );
  await page
    .getByRole("button", { name: enMessages.activity.welcomeStart })
    .click();
  await expect(
    page.getByRole("button", { name: enMessages.activity.pause, exact: true }),
  ).toBeVisible();
  await page
    .locator("summary")
    .filter({ hasText: enMessages.activity.settings })
    .click();
  await expect(details).not.toBeChecked();
  expect(await tauriInvocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "activity_set_capture_details" }),
  );
});

test("detail capture changes only on explicit choice and can be turned off in settings", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: { ...SNAPSHOT, recordingStatus: "off" },
  });
  const details = page.getByRole("checkbox", {
    name: enMessages.activity.captureDetails,
  });
  await details.check();
  await expect(details).toBeChecked();
  expect(await tauriInvocations(page)).toContainEqual({
    command: "activity_set_capture_details",
    args: { enabled: true },
  });
  await page
    .getByRole("button", { name: enMessages.activity.welcomeStart })
    .click();
  await expect(
    page.getByRole("button", { name: enMessages.activity.pause, exact: true }),
  ).toBeVisible();
  await page
    .locator("summary")
    .filter({ hasText: enMessages.activity.settings })
    .click();
  await details.uncheck();
  await expect(details).not.toBeChecked();
  expect(await tauriInvocations(page)).toContainEqual({
    command: "activity_set_capture_details",
    args: { enabled: false },
  });
});

test("accessibility hint opens system settings only after a user request", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: {
      ...SNAPSHOT,
      captureDetails: true,
      detailsAccess: "accessibilityRequired",
    },
  });
  await expect(
    page.getByText(enMessages.activity.accessibilityRequired, { exact: true }),
  ).toBeVisible();
  expect(await tauriInvocations(page)).not.toContainEqual(
    expect.objectContaining({
      command: "activity_open_accessibility_settings",
    }),
  );
  await page
    .getByRole("button", {
      name: enMessages.activity.openAccessibilitySettings,
    })
    .click();
  expect(await tauriInvocations(page)).toContainEqual({
    command: "activity_open_accessibility_settings",
    args: {},
  });
});

test("per-app detail controls keep time recording and allow details to be restored", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: {
      ...SNAPSHOT,
      captureDetails: true,
      detailsAccess: "ready",
    },
  });
  await page
    .getByRole("button", { name: "Record app name only for Example Editor" })
    .click();
  await expect(
    page
      .getByRole("button", { name: "Record details for Example Editor" })
      .first(),
  ).toBeVisible();
  expect(await tauriInvocations(page)).toContainEqual({
    command: "activity_set_app_detail_capture",
    args: {
      identifier: "com.example.editor",
      name: "Example Editor",
      mode: "appNameOnly",
    },
  });
  expect(await tauriInvocations(page)).not.toContainEqual(
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
  expect(await tauriInvocations(page)).toContainEqual({
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
  await installNativeBoundary({
    page,
    snapshot: {
      ...SNAPSHOT,
      captureDetails: true,
      detailsAccess: "ready",
      browserApps: [browser],
    },
  });
  const browserTitles = page.getByRole("checkbox", {
    name: "Record window titles in Native Browser",
  });
  await expect(browserTitles).not.toBeChecked();
  await expect(
    page.getByText(enMessages.activity.browserPrivacyNote, { exact: true }),
  ).toBeVisible();
  expect(await tauriInvocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "activity_set_browser_title_capture" }),
  );
  await browserTitles.check();
  await expect(browserTitles).toBeChecked();
  expect(await tauriInvocations(page)).toContainEqual({
    command: "activity_set_browser_title_capture",
    args: { identifier: browser.identifier, name: browser.name, enabled: true },
  });
  await browserTitles.uncheck();
  await expect(browserTitles).not.toBeChecked();
  expect(await tauriInvocations(page)).toContainEqual({
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
    await installNativeBoundary({
      page,
      snapshot: {
        ...SNAPSHOT,
        captureDetails: prerequisite !== "globalOff",
        detailsAccess: prerequisite === "globalOff" ? "disabled" : "ready",
        browserApps: [browser],
        appNameOnlyApps: prerequisite === "appNameOnly" ? [browser] : [],
      },
    });
    await expect(
      page.getByRole("checkbox", {
        name: "Record window titles in Native Browser",
      }),
    ).toBeDisabled();
    expect(await tauriInvocations(page)).not.toContainEqual(
      expect.objectContaining({
        command: "activity_set_browser_title_capture",
      }),
    );
  });
}

test("document names render locally without publishing full paths", async ({
  page,
}) => {
  const document = "/private/synthetic/memo.docx";
  await installNativeBoundary({
    page,
    snapshot: {
      ...SNAPSHOT,
      captureDetails: true,
      detailsAccess: "ready",
      segments: SNAPSHOT.segments.map((entry) => ({
        ...entry,
        document,
        windowTitle: "Synthetic title",
      })),
    },
  });
  await expect(page.getByText(/memo\.docx/u).first()).toBeVisible();
  await expect(page.getByText(document, { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: /Example Editor$/u })
    .first()
    .hover();
  const tooltip = page.locator('[data-slot="tooltip-popup"]');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("memo.docx");
  await expect(tooltip).not.toContainText(document);
  expect(await tauriInvocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "activity_copy_text" }),
  );
  await page
    .getByRole("button", { name: enMessages.activity.copySummary })
    .click();
  await expect(
    page.getByRole("button", { name: enMessages.activity.copied }),
  ).toBeVisible();
  expect(await tauriInvocations(page)).toContainEqual({
    command: "activity_copy_text",
    args: { text: expect.stringContaining("memo.docx") },
  });
  expect(await tauriInvocations(page)).not.toContainEqual({
    command: "activity_copy_text",
    args: { text: expect.stringContaining(document) },
  });
});

test("short matched activity counts toward its matter draft", async ({
  page,
}) => {
  const sample = SNAPSHOT.segments.at(0);
  if (!sample) {
    throw new TypeError("Activity fixture must contain a segment");
  }
  await installNativeBoundary({
    page,
    snapshot: {
      ...SNAPSHOT,
      segments: [
        {
          ...sample,
          start: "2026-10-07T09:00:00Z",
          end: "2026-10-07T09:02:59Z",
        },
      ],
    },
  });
  await expect(
    page.getByRole("heading", {
      name: enMessages.activity.reviewToday,
      exact: true,
    }),
  ).toBeAttached();
  await expect(
    page.getByRole("button", { name: "Create 1 draft", exact: true }),
  ).toBeEnabled();
  await expect(page.getByText("0.1 h", { exact: true })).toHaveAttribute(
    "title",
    enMessages.activity.roundedSixMinutes,
  );
});

for (const language of ["en", "ar"] as const) {
  test(`welcome privacy details disclose on request in ${language}`, async ({
    page,
  }, testInfo) => {
    const messages = language === "ar" ? arMessages : enMessages;
    await page.setViewportSize({ width: 820, height: 950 });
    await installNativeBoundary({
      page,
      snapshot: { ...SNAPSHOT, recordingStatus: "off" },
      language,
    });
    await expect(
      page.getByText(messages.activity.welcomeDetails, { exact: true }),
    ).toBeHidden();
    await expect(page.locator("html")).toHaveAttribute(
      "dir",
      language === "ar" ? "rtl" : "ltr",
    );
    await expect(page.locator("[data-activity-preview-matter]")).toHaveCSS(
      "opacity",
      "1",
    );
    await page.screenshot({
      path: testInfo.outputPath(`welcome-${language}.png`),
      fullPage: true,
    });
    await page
      .getByText(messages.activity.welcomeLearnMore, { exact: true })
      .click();
    await expect(
      page.getByText(messages.activity.welcomeDetails, { exact: true }),
    ).toBeVisible();
    expect(await tauriInvocations(page)).not.toContainEqual(
      expect.objectContaining({ command: "activity_set_recording_status" }),
    );
  });
}

test("app totals reuse local app visuals and keep a neutral fallback", async ({
  page,
}) => {
  const iconDataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=";
  await installNativeBoundary({
    page,
    snapshot: {
      ...SNAPSHOT,
      sourceAppVisuals: [
        { key: "com.example.editor", iconDataUrl, color: null },
      ],
      segments: [
        ...SNAPSHOT.segments,
        {
          appIdentifier: "com.example.viewer",
          appName: "Preview",
          start: "2026-10-07T10:00:00Z",
          end: "2026-10-07T10:10:00Z",
        },
      ],
    },
  });
  const totals = page
    .getByRole("heading", { name: enMessages.activity.byApp, exact: true })
    .locator("..");
  const editor = totals
    .getByRole("listitem")
    .filter({ hasText: "Example Editor" });
  await expect(editor.locator("img")).toHaveAttribute("src", iconDataUrl);
  const fallback = totals.getByRole("listitem").filter({ hasText: "Preview" });
  await expect(fallback.locator("img")).toHaveCount(0);
  await expect(fallback.locator("svg").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Stop recording Example Editor" })
    .click();
  await expect(
    page.getByRole("dialog").getByRole("heading").locator("img"),
  ).toHaveAttribute("src", iconDataUrl);
});

for (const motion of ["no-preference", "reduce"] as const) {
  test(`welcome sample completes once with ${motion} motion`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: motion });
    await installNativeBoundary({
      page,
      snapshot: { ...SNAPSHOT, recordingStatus: "off", segments: [] },
    });
    const preview = page.locator("[data-activity-preview]");
    await expect(preview).toHaveAttribute("aria-hidden", "true");
    await expect(preview).toHaveAttribute("inert", "");
    await expect(
      preview.getByText(enMessages.activity.timelineHint, { exact: true }),
    ).toHaveCount(0);
    await expect(
      preview.getByRole("button", {
        name: enMessages.activity.selectRange,
        includeHidden: true,
      }),
    ).toHaveCount(0);
    const matterSegments = preview.locator(
      "[data-activity-segment][data-activity-matter]",
    );
    await expect(matterSegments).toHaveCount(previewApps.length);
    for (const segment of await matterSegments.all()) {
      expect(
        await segment.evaluate((element) =>
          element instanceof HTMLElement ? element.style.backgroundColor : null,
        ),
      ).toBe("var(--option-emerald)");
    }
    const proposed = preview.locator("[data-activity-preview-matter]");
    if (motion === "reduce") {
      await expect(proposed).toHaveCSS("animation-name", "none");
      await expect(
        preview.locator("[data-activity-preview-duration-before]"),
      ).toBeHidden();
    } else {
      await expect(proposed).toHaveCSS("animation-duration", "0.2s");
      await expect(proposed).toHaveCSS("animation-delay", "2.4s");
      await expect(proposed).toHaveCSS("animation-iteration-count", "1");
    }
    await expect(proposed).toHaveCSS("opacity", "1");
    await expect(
      preview.locator("[data-activity-preview-duration-after]"),
    ).toContainText("18");
    expect(
      await preview.evaluate(
        (node) =>
          node
            .getAnimations({ subtree: true })
            .filter((animation) => animation.playState === "running").length,
      ),
    ).toBe(0);
    await page
      .getByRole("button", { name: enMessages.activity.welcomeStart })
      .click();
    await expect(preview).toHaveCount(0);
  });
}

test("welcome uses native icons for sample apps without recorded activity", async ({
  page,
}) => {
  const iconDataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=";
  const missing = previewApps.at(-1);
  await installNativeBoundary({
    page,
    snapshot: {
      ...SNAPSHOT,
      recordingStatus: "off",
      segments: [],
      sourceAppVisuals: previewApps
        .filter(({ appIdentifier }) => appIdentifier !== missing?.appIdentifier)
        .map(({ appIdentifier }) => ({
          key: appIdentifier,
          iconDataUrl,
          color: null,
        })),
    },
  });
  const preview = page.locator("[data-activity-preview]");
  for (const { appIdentifier, appName } of previewApps) {
    const total = preview.locator("li").filter({ hasText: appName });
    if (appIdentifier === missing?.appIdentifier) {
      await expect(total.locator("img")).toHaveCount(0);
      await expect(total.locator("svg")).toBeVisible();
    } else {
      await expect(total.locator("img")).toHaveAttribute("src", iconDataUrl);
      const timelineApp = preview.getByRole("button", {
        name: new RegExp(`${appName}$`, "u"),
        includeHidden: true,
      });
      await expect(timelineApp.locator("img")).toHaveAttribute(
        "src",
        iconDataUrl,
      );
    }
  }
});

test("invalid range endpoints remain editable until their order is repaired", async ({
  page,
}) => {
  await installNativeBoundary({ page });
  await page.locator("button[data-activity-segment]").first().click();
  const start = page.getByRole("group", {
    name: enMessages.activity.rangeStart,
    exact: true,
  });
  const end = page.getByRole("group", {
    name: enMessages.activity.rangeEnd,
    exact: true,
  });
  const startMinutes = start.getByRole("spinbutton").nth(1);
  const endMinutes = end.getByRole("spinbutton").nth(1);
  await startMinutes.fill("0");
  await end
    .getByRole("spinbutton")
    .nth(0)
    .fill(await start.getByRole("spinbutton").nth(0).inputValue());
  await endMinutes.fill("0");
  await expect(start).toBeVisible();
  await expect(end).toBeVisible();
  await expect(endMinutes).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByRole("button", { name: enMessages.activity.assignRange }),
  ).toBeDisabled();
  await endMinutes.fill("30");
  await expect(endMinutes).toHaveAttribute("aria-invalid", "false");
  await expect(
    page.getByRole("button", { name: enMessages.activity.assignRange }),
  ).toBeEnabled();
});

test("a call segment reads as a call in the timeline and its tooltip", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: {
      ...SNAPSHOT,
      segments: [
        ...SNAPSHOT.segments,
        {
          appIdentifier: "com.microsoft.teams2",
          appName: "Microsoft Teams",
          call: true,
          start: "2026-10-07T09:30:00Z",
          end: "2026-10-07T10:00:00Z",
        },
      ],
    },
  });
  const callLabel = enMessages.activity.callIn.replace(
    "{app}",
    "Microsoft Teams",
  );
  const call = page
    .getByRole("button", { name: new RegExp(`${callLabel}$`, "u") })
    .first();
  const editor = page.getByRole("button", { name: /Example Editor$/u }).first();
  await expect(call).toBeVisible();
  await expect(call.locator("svg.lucide-phone")).toHaveCount(1);
  await expect(editor.locator("svg.lucide-phone")).toHaveCount(0);
  await call.hover();
  const tooltip = page.locator('[data-slot="tooltip-popup"]');
  await expect(tooltip).toContainText(callLabel);
  await editor.hover();
  await expect(tooltip).toContainText("Example Editor");
  await expect(tooltip).not.toContainText(callLabel);
});

test("call recording is on by default and changes only on explicit choice", async ({
  page,
}) => {
  // The boundary opens settings for a recording day.
  await installNativeBoundary({ page });
  const calls = page.getByRole("checkbox", {
    name: enMessages.activity.detectCalls,
  });
  await expect(calls).toBeChecked();
  await expect(
    page.getByText(enMessages.activity.detectCallsDescription),
  ).toBeVisible();
  expect(await tauriInvocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "activity_set_detect_calls" }),
  );
  await calls.uncheck();
  await expect(calls).not.toBeChecked();
  expect(await tauriInvocations(page)).toContainEqual({
    command: "activity_set_detect_calls",
    args: { enabled: false },
  });
  expect(await tauriInvocations(page)).not.toContainEqual({
    command: "activity_set_detect_calls",
    args: { enabled: true },
  });
  await calls.check();
  await expect(calls).toBeChecked();
  expect(await tauriInvocations(page)).toContainEqual({
    command: "activity_set_detect_calls",
    args: { enabled: true },
  });
  expect(await tauriInvocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "activity_set_capture_details" }),
  );
});
