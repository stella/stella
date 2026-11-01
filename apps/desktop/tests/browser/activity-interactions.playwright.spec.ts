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
import { detectDesktopPlatform } from "../../src/shared/shortcut-keys";
import { DESKTOP_WINDOW_SIZES } from "../desktop-window-sizes";
import {
  ACCOUNT,
  APP_STATE,
  PERMISSIONS,
  SHORTCUT,
} from "./fixtures/desktop-window-snapshots";
import { installTauriIpc, tauriInvocations } from "./tauri-ipc";
import type { TauriInvocation } from "./tauri-ipc";

const SNAPSHOT = {
  date: "2026-10-07",
  draftedEntries: [],
  manualAssignments: [],
  pendingBatch: null,
  deletionStatus: "available",
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
  /**
   * The activity window, or the Settings window on its Activity tab. Both
   * read the same native state, so a change in one shows in the other.
   */
  view?: "activity" | "settings";
  /** Whether the account has the activity feature. */
  activityEnabled?: boolean;
  /** The firm's AI drafting mode, the user's consent on the server, and how
   * a drafting request settles. */
  drafting?: DraftingFixture;
};

type DraftingFixture = {
  mode: "off" | "plain" | "guided";
  consent: "granted" | "revoked";
  generation: "write" | "fail";
  /** Drafting requests wait until the test calls `releaseDraft`. */
  held?: boolean;
  /** The remembered drafting instruction the server starts with. */
  preference?: string;
  /** What a guided draft proposes beyond its text, as the contract spells
   * it, and whether its guideline note is fixed by a split. */
  operations?: unknown[];
  flagFix?: "split";
};

const RELEASE_DRAFT = "__STELLA_TEST_RELEASE_DRAFT__";

const heldDrafts = async (page: Page) =>
  page.evaluate((key) => {
    const held: unknown = Reflect.get(window, key);
    return Array.isArray(held) ? held.length : 0;
  }, RELEASE_DRAFT);

/** Waits for a drafting request to be held, then lets every held one settle. */
const releaseDraft = async (page: Page) => {
  await expect.poll(async () => heldDrafts(page)).toBeGreaterThan(0);
  await page.evaluate((key) => {
    const held: unknown = Reflect.get(window, key);
    if (!Array.isArray(held)) {
      throw new TypeError("No drafting request is held");
    }
    for (const release of held.splice(0)) {
      if (typeof release === "function") {
        release();
      }
    }
  }, RELEASE_DRAFT);
};

const DRAFTING: DraftingFixture = {
  mode: "plain",
  consent: "revoked",
  generation: "write",
};

/** What the mocked stella AI writes for a drafted suggestion. */
const GENERATED_NARRATIVE = "Reviewed the lease draft and its annexes.";
/** What it writes when asked to adjust a draft. */
const REFINED_NARRATIVE = "Reviewed the lease draft.";

/** The user's earlier entry the mocked draft follows. */
const EARLIER_ENTRY = {
  id: "00000000-0000-4000-8000-0000000000e1",
  dateWorked: "2026-10-02",
  durationMinutes: 42,
  narrative: "Reviewed the lease annex.",
};

const installNativeBoundary = async ({
  page,
  snapshot = SNAPSHOT,
  additionalSnapshots = [],
  language = "en",
  batchValidation = "accept",
  batchReceipt = "save",
  historyDeletion = "available",
  firstRenderTimeoutMs,
  view = "activity",
  activityEnabled = true,
  drafting = DRAFTING,
}: InstallNativeBoundaryOptions) => {
  expect(isActivityDaySnapshot(snapshot)).toBe(true);
  await setFixedBrowserTime(page, new Date(`${snapshot.today}T10:00:00Z`));
  await installTauriIpc(page, {
    windowLabel: view === "settings" ? "main" : "activity",
    unhandled: "resolveUndefined",
    arg: {
      snapshot,
      additionalSnapshots,
      changedEvent: ACTIVITY_CHANGED_EVENT,
      language,
      batchValidation,
      batchReceipt,
      historyDeletion,
      drafting,
      generatedNarrative: GENERATED_NARRATIVE,
      refinedNarrative: REFINED_NARRATIVE,
      earlierEntry: EARLIER_ENTRY,
      releaseDraftKey: RELEASE_DRAFT,
      settingsWindow: {
        account: ACCOUNT,
        activityEnabled,
        appState: APP_STATE,
        permissions: PERMISSIONS,
        shortcut: SHORTCUT,
      },
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
        drafting: draftingFixture,
        generatedNarrative,
        refinedNarrative,
        earlierEntry,
        releaseDraftKey,
        settingsWindow,
      },
      { emit },
    ) => {
      let batchAttempts = 0;
      let activitySnapshot = initialSnapshot;
      let draftConsent = draftingFixture.consent;
      let draftPreference = draftingFixture.preference ?? null;
      let draftRevision = 1;
      const scopedDraftSettings = () => ({
        scopeKey: '["org_fixture","user_fixture"]',
        settings: {
          revision: `revision-${String(draftRevision)}`,
          effectiveMode: draftingFixture.mode,
          consent: draftConsent,
          preference: draftPreference,
        },
      });
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
        // The native settings read: the day's settings and deletion state
        // with the names of its apps, longest first, never its segments.
        activity_get_settings: (args) => {
          const day =
            otherDays.find((candidate) => candidate.date === args["date"]) ??
            activitySnapshot;
          const totals = new Map<
            string,
            { identifier: string; name: string; durationMs: number }
          >();
          for (const segment of day.segments) {
            const durationMs =
              Date.parse(segment.end) - Date.parse(segment.start);
            const total = totals.get(segment.appIdentifier);
            if (total) {
              total.durationMs += durationMs;
              continue;
            }
            totals.set(segment.appIdentifier, {
              identifier: segment.appIdentifier,
              name: segment.appName,
              durationMs,
            });
          }
          return {
            date: args["date"] ?? activitySnapshot.date,
            today: day.today,
            earliestDate: day.earliestDate,
            latestDate: day.latestDate,
            deletionStatus: day.deletionStatus,
            persistence: day.persistence,
            retention: day.retention,
            excludedApps: day.excludedApps,
            otherAccountHistoryDays: day.otherAccountHistoryDays,
            captureDetails: day.captureDetails,
            detectCalls: day.detectCalls,
            appNameOnlyApps: day.appNameOnlyApps,
            detailsAccess: day.detailsAccess,
            browserApps: day.browserApps,
            browserTitleApps: day.browserTitleApps,
            sourceAppVisuals: day.sourceAppVisuals,
            apps: [...totals.values()]
              .toSorted(
                (left, right) =>
                  right.durationMs - left.durationMs ||
                  left.name.localeCompare(right.name),
              )
              .map(({ identifier, name }) => ({ identifier, name })),
          };
        },
        is_activity_enabled: () => settingsWindow.activityEnabled,
        get_state: () => settingsWindow.appState,
        account_get_state: () => settingsWindow.account,
        get_desktop_telemetry_enabled: () => true,
        permissions_get_snapshot: () => settingsWindow.permissions,
        shortcut_get_snapshot: () => settingsWindow.shortcut,
        chatgpt_auth_get_status: () => null,
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
        billing_draft_get_settings: () => scopedDraftSettings(),
        billing_draft_grant_consent: (args) => {
          if (args["revision"] !== `revision-${String(draftRevision)}`) {
            throw new Error("billing draft request failed");
          }
          draftConsent = "granted";
          draftRevision += 1;
          return scopedDraftSettings();
        },
        billing_draft_set_preference: (args) => {
          if (args["revision"] !== `revision-${String(draftRevision)}`) {
            throw new Error("billing draft request failed");
          }
          const preference = args["preference"];
          draftPreference = typeof preference === "string" ? preference : null;
          draftRevision += 1;
          return scopedDraftSettings();
        },
        billing_draft_withdraw_consent: () => {
          draftConsent = "revoked";
          draftRevision += 1;
          return scopedDraftSettings();
        },
        billing_draft_create_confirmed: async (args) => {
          if (draftingFixture.held === true) {
            const held = Promise.withResolvers<undefined>();
            const queue: unknown = Reflect.get(window, releaseDraftKey);
            const releases = Array.isArray(queue) ? queue : [];
            releases.push(() => {
              held.resolve(undefined);
            });
            Reflect.set(window, releaseDraftKey, releases);
            await held.promise;
          }
          const request = args["request"];
          if (
            typeof request !== "object" ||
            request === null ||
            !("entries" in request) ||
            !Array.isArray(request.entries)
          ) {
            throw new TypeError("Drafting request is missing");
          }
          if (draftConsent !== "granted") {
            // The native boundary rejects with its typed failure.
            throw Object.assign(new Error("billing draft request failed"), {
              type: "consentRequired",
            });
          }
          if (draftingFixture.generation === "fail") {
            // The native boundary rejects with its typed failure.
            throw Object.assign(new Error("billing draft request failed"), {
              type: "failed",
            });
          }
          if (draftingFixture.mode === "guided") {
            return {
              result: {
                mode: "guided",
                drafts: request.entries.map((entry: { entryId: string }) => ({
                  entryId: entry.entryId,
                  narrative:
                    "steer" in request ? refinedNarrative : generatedNarrative,
                  classification: {
                    type: "ledes",
                    taskCode: "L120",
                    activityCode: "A104",
                  },
                  flags: [
                    {
                      text: "List each task separately.",
                      ruleRef: {
                        fileId: "guideline-1",
                        fileName: "Outside counsel guidelines.pdf",
                        section: "4.2",
                      },
                      ...(draftingFixture.flagFix === undefined
                        ? {}
                        : { fix: draftingFixture.flagFix }),
                    },
                  ],
                  matchedEarlierEntryIds: [earlierEntry.id],
                  operations: draftingFixture.operations ?? [],
                })),
                checkedGuidelines: [
                  {
                    fileId: "guideline-1",
                    fileName: "Outside counsel guidelines.pdf",
                  },
                ],
              },
              earlierEntries: [earlierEntry],
            };
          }
          return {
            result: {
              mode: "plain",
              drafts: request.entries.map((entry: { entryId: string }) => ({
                entryId: entry.entryId,
                narrative:
                  "steer" in request ? refinedNarrative : generatedNarrative,
                matchedEarlierEntryIds: [earlierEntry.id],
              })),
            },
            earlierEntries: [earlierEntry],
          };
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
              color: "--option-emerald",
            },
            { id: "matter-2", name: "Second matter", color: "--option-violet" },
            { id: "matter-3", name: "Third matter", color: null },
            { id: "matter-4", name: "Fourth matter", color: null },
          ].map(
            ({ id, name, color }, index) =>
              ({
                id,
                name,
                reference: `M-00${String(index + 1)}`,
                color,
                clientName: "Example client",
                signals: {
                  lastWorkedAt: "2026-10-06",
                  newlyAssignedAt: null,
                  upcomingDeadline: null,
                },
              }) satisfies DesktopTimeEntryMatterCandidate,
          ),
        time_entry_submit_batch_confirmed: async (args) => {
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
          const request = args["request"];
          const items =
            typeof request === "object" &&
            request !== null &&
            "items" in request &&
            Array.isArray(request.items)
              ? request.items
              : [];
          return {
            entries: items.map((_item: unknown, index: number) => ({
              id: `draft-${String(batchAttempts)}-${String(index)}`,
              matterId: "matter-1",
            })),
            markerSaved,
          };
        },
        get_desktop_language: () => desktopLanguage,
      };
    },
  });
  const messages = language === "ar" ? arMessages : enMessages;
  const deletionOnlyNotice = page.getByText(
    {
      keyMissing: messages.activity.deletionOnly,
      unreadable: messages.activity.unreadableEraseNotice,
      available: messages.activity.errorRead,
      pending: messages.activity.errorRead,
      unavailable: messages.activity.errorRead,
      incompatible: messages.activity.incompatibleActivity,
    }[snapshot.deletionStatus],
  );
  if (view === "settings") {
    await page.setViewportSize(DESKTOP_WINDOW_SIZES.settings);
    await page.goto("/#activity");
    if (!activityEnabled) {
      await expect(page.getByRole("tabpanel")).toBeVisible();
      return;
    }
    await expect(
      snapshot.persistence === "deletionOnly"
        ? deletionOnlyNotice
        : page.getByRole("heading", {
            name: messages.activity.byApp,
            exact: true,
          }),
    ).toBeVisible();
    return;
  }
  await page.goto("/");
  if (snapshot.persistence === "deletionOnly") {
    await expect(deletionOnlyNotice).toBeVisible();
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
};

type Messages = typeof enMessages;

const ACTIVITY_BLOCKS =
  '[data-column-id="activity"] [data-slot="day-calendar-block"]';
const SUGGESTION_BLOCKS =
  '[data-column-id="entries"] button[data-state="suggestion"]';

const escapePattern = (text: string) =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** The button names carry their shortcut hint after the label. */
const acceptName = (messages: Messages) =>
  new RegExp(`^${escapePattern(messages.activity.accept)}`, "u");
const rejectName = (messages: Messages) =>
  new RegExp(`^${escapePattern(messages.activity.reject)}`, "u");

const suggestionCard = (page: Page, matter: string) =>
  page.getByRole("region", { name: matter, exact: true });

/** Presses a card shortcut with the primary modifier the window reads from
 * its own user agent; Playwright's WebKit reports macOS on every host. */
const pressCardShortcut = async (page: Page, key: "Backspace" | "Enter") => {
  const platform = detectDesktopPlatform(
    await page.evaluate(() => navigator.userAgent),
  );
  await page.keyboard.press(
    `${platform === "mac" ? "Meta" : "Control"}+${key}`,
  );
};

// A block shorter than one line draws no text, so blocks are found by the
// accessible label every block carries.
const openSuggestion = async (page: Page, matter: string) => {
  await page
    .locator(SUGGESTION_BLOCKS)
    .and(page.locator(`[aria-label*="${matter}"]`))
    .first()
    .click();
  await expect(suggestionCard(page, matter)).toBeFocused();
};

const batchRequests = (calls: TauriInvocation[]) =>
  calls.flatMap(({ args, command }) =>
    command === "time_entry_submit_batch_confirmed" ? [args["request"]] : [],
  );

/** Four matters, half an hour each, with recorded window titles. */
const TRIAGE_SNAPSHOT = {
  ...SNAPSHOT,
  captureDetails: true,
  detailsAccess: "ready",
  segments: [
    { matterId: "matter-1", windowTitle: "Lease draft.docx", hour: "09" },
    { matterId: "matter-2", windowTitle: "Service agreement.docx", hour: "10" },
    { matterId: "matter-3", windowTitle: "Board minutes.docx", hour: "11" },
    { matterId: "matter-4", windowTitle: "Lease annex.docx", hour: "12" },
  ].map(({ matterId, windowTitle, hour }) => ({
    appIdentifier: "com.example.editor",
    appName: "Example Editor",
    matterId,
    windowTitle,
    start: `2026-10-07T${hour}:00:00Z`,
    end: `2026-10-07T${hour}:30:00Z`,
  })),
} satisfies ActivityDaySnapshot;

for (const history of ["keep", "delete"] as const) {
  test(`excluding an app waits for the ${history} history choice`, async ({
    page,
  }) => {
    await installNativeBoundary({ page, view: "settings" });
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
  await installNativeBoundary({ page, view: "settings" });
  await page
    .getByRole("button", { name: "Stop recording Example Editor" })
    .click();
  await page.getByRole("button", { name: enMessages.activity.cancel }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(await tauriInvocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "activity_exclude_app" }),
  );
});

test("only Accept sends the edited billing fields and the suggestion becomes a draft", async ({
  page,
}) => {
  await installNativeBoundary({ page });
  const suggestions = page.locator(SUGGESTION_BLOCKS);
  await expect(suggestions).toHaveCount(1);
  await expect(suggestions).toHaveAttribute(
    "aria-label",
    enMessages.activity.suggestionLabel
      .replace("{matter}", "Example matter")
      .replace("{hours}", "0.5"),
  );
  await openSuggestion(page, "Example matter");
  const card = suggestionCard(page, "Example matter");
  const narrative = card.getByRole("textbox", {
    name: enMessages.activity.entryNarrative,
  });
  await expect(narrative).toHaveValue("Work in Example Editor");
  const billable = card.getByRole("switch", {
    name: enMessages.activity.entryBillable,
  });
  await expect(billable).toBeChecked();
  await billable.click();
  await narrative.fill("Draft-only confidential narrative 71f3");
  const callsBefore = await tauriInvocations(page);
  expect(batchRequests(callsBefore)).toEqual([]);
  expect(callsBefore).not.toContainEqual(
    expect.objectContaining({ command: "activity_copy_text" }),
  );
  await card.getByRole("button", { name: acceptName(enMessages) }).click();
  await expect(page.getByRole("status")).toContainText("1 draft created");
  const timezoneId = await page.evaluate(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const calls = await tauriInvocations(page);
  expect(batchRequests(calls)).toEqual([
    {
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
            billable: false,
          },
          ranges: [
            { start: "2026-10-07T09:00:00Z", end: "2026-10-07T09:30:00Z" },
          ],
        },
      ],
    },
  ]);
  // The local native boundary receives receipts, without app identities or raw segments.
  const submissions = JSON.stringify(batchRequests(calls));
  expect(submissions).not.toContain("Example Editor");
  expect(submissions).not.toContain("appIdentifier");
  expect(submissions).not.toContain("windowTitle");
  expect(submissions).not.toContain('"segments"');
  await expect(suggestions).toHaveCount(0);
  await expect(
    page.locator(
      '[data-column-id="entries"] [data-slot="day-calendar-block"][data-state="final"]',
    ),
  ).toHaveCount(1);
});

test("a rejected acceptance stays editable and the next acceptance uses a new batch key", async ({
  page,
}) => {
  await installNativeBoundary({ page, batchValidation: "reject-first" });
  await openSuggestion(page, "Example matter");
  const accept = page.getByRole("button", { name: acceptName(enMessages) });
  await accept.click();
  await expect(page.getByRole("alert")).toContainText(
    enMessages.activity.batchFailed,
  );
  await expect(
    page.getByRole("button", {
      name: enMessages.activity.pendingRetry,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(accept).toBeEnabled();
  await accept.click();
  await expect(page.getByRole("status")).toContainText("1 draft created");
  const requests = batchRequests(await tauriInvocations(page));
  const entryFor = (matterId: string) =>
    expect.objectContaining({
      items: [
        expect.objectContaining({
          entry: expect.objectContaining({ matterId }),
        }),
      ],
    });
  expect(requests).toEqual([entryFor("matter-1"), entryFor("matter-1")]);
  const keys = requests.map((request) =>
    typeof request === "object" &&
    request !== null &&
    "idempotencyKey" in request
      ? request.idempotencyKey
      : null,
  );
  expect(new Set(keys).size).toBe(2);
});

test("unresolved draft creation offers no deletion and retains its batch key", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    batchValidation: "hold-first",
    snapshot: { ...SNAPSHOT, otherAccountHistoryDays: 1 },
  });
  await openSuggestion(page, "Example matter");
  await page.getByRole("button", { name: acceptName(enMessages) }).click();
  // Deletion lives in the Settings window, which the native pending state
  // blocks (see the pending settings test below).
  for (const name of [
    enMessages.activity.deleteDay,
    enMessages.activity.deleteAll,
    enMessages.activity.deleteOtherAccountHistory,
    enMessages.activity.excludeApp.replace("{name}", "Example Editor"),
  ]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );
  }
  await expect(
    page.getByRole("button", { name: enMessages.activity.previousDay }),
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

test("pending drafts protect every deletion in the activity settings", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    view: "settings",
    snapshot: {
      ...SNAPSHOT,
      deletionStatus: "pending",
      otherAccountHistoryDays: 1,
    },
  });
  for (const name of [
    enMessages.activity.deleteDay,
    enMessages.activity.deleteAll,
    enMessages.activity.deleteOtherAccountHistory,
    enMessages.activity.excludeApp.replace("{name}", "Example Editor"),
  ]) {
    await expect(
      page.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  }
  await expect(
    page.getByText(enMessages.activity.pendingActivityProtected, {
      exact: true,
    }),
  ).toBeVisible();
  for (const command of [
    "activity_delete_day",
    "activity_delete_all",
    "activity_delete_other_account_history",
    "activity_exclude_app",
  ]) {
    expect(await tauriInvocations(page)).not.toContainEqual(
      expect.objectContaining({ command }),
    );
  }
});

for (const recordingStatus of ["recording", "off"] as const) {
  test(`pending drafts on another day permit recovery navigation while ${recordingStatus}`, async ({
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
  await openSuggestion(page, "Example matter");
  const accept = page.getByRole("button", { name: acceptName(enMessages) });
  await expect(accept).toBeDisabled();
  await page.evaluate((next) => {
    const update = Reflect.get(window, "__STELLA_TEST_SET_SNAPSHOT__");
    if (typeof update !== "function") {
      throw new TypeError("Snapshot control is missing");
    }
    update(next);
  }, SNAPSHOT);
  await expect(retry).toHaveCount(0);
  await expect(accept).toBeEnabled();
});

test("unreadable saved activity explains why deletion is unavailable", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    view: "settings",
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

for (const deletionStatus of ["keyMissing", "unreadable"] as const) {
  test(`saved activity that cannot be opened (${deletionStatus}) sends recovery to the settings`, async ({
    page,
  }) => {
    await installNativeBoundary({
      page,
      snapshot: {
        ...SNAPSHOT,
        persistence: "deletionOnly",
        recordingStatus: "off",
        deletionStatus,
        otherAccountHistoryDays: 3,
      },
    });
    for (const name of [
      enMessages.activity.deleteAll,
      enMessages.activity.unreadableEraseAction,
      enMessages.activity.deleteOtherAccountHistory,
    ]) {
      await expect(page.getByRole("button", { name, exact: true })).toHaveCount(
        0,
      );
    }
    await page
      .getByRole("button", { name: enMessages.activity.settings, exact: true })
      .click();
    expect(await tauriInvocations(page)).toContainEqual({
      command: "activity_open_settings",
      args: {},
    });
  });
}

test("the activity window opens its settings in the Settings window", async ({
  page,
}) => {
  await installNativeBoundary({ page });
  await page
    .getByRole("button", { name: enMessages.activity.settings, exact: true })
    .click();
  expect(await tauriInvocations(page)).toContainEqual({
    command: "activity_open_settings",
    args: {},
  });
});

test("the Activity tab is absent while the activity feature is off", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    view: "settings",
    activityEnabled: false,
  });
  await expect(
    page.getByRole("tab", { name: enMessages.settings.general, exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("tab", { name: enMessages.activity.title, exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: enMessages.activity.byApp, exact: true }),
  ).toHaveCount(0);
  expect(await tauriInvocations(page)).toContainEqual({
    command: "is_activity_enabled",
    args: {},
  });
  expect(await tauriInvocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "activity_get_settings" }),
  );
});

test("the Activity tab reads settings, never the day timeline", async ({
  page,
}) => {
  await installNativeBoundary({ page, view: "settings" });
  await expect(
    page.getByRole("tab", { name: enMessages.activity.title, exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const commands = (await tauriInvocations(page)).map(({ command }) => command);
  expect(commands).toContain("activity_get_settings");
  expect(commands).not.toContain("activity_get_day");
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
      view: "settings",
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

const UNREADABLE_PENDING_SNAPSHOT = {
  ...SNAPSHOT,
  segments: [],
  pendingBatch: PENDING_BATCH,
  unreadable: true,
  deletionStatus: "unreadable",
} satisfies ActivityDaySnapshot;

test("stored pending retry over unreadable activity stays retryable", async ({
  page,
}) => {
  await installNativeBoundary({ page, snapshot: UNREADABLE_PENDING_SNAPSHOT });
  await expect(
    page.getByRole("button", {
      name: enMessages.activity.pendingRetry,
      exact: true,
    }),
  ).toBeVisible();
});

test("stored pending retry permits confirmed unreadable repair while ordinary deletion stays blocked", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    view: "settings",
    snapshot: UNREADABLE_PENDING_SNAPSHOT,
  });
  const deleteDay = page.getByRole("button", {
    name: enMessages.activity.deleteDay,
    exact: true,
  });
  await expect(deleteDay).toBeDisabled();
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
  await expect(repair).toHaveCount(0);
  await expect(deleteDay).toBeEnabled();
  expect(await tauriInvocations(page)).toContainEqual({
    command: "activity_delete_all",
    args: { recovery: "discardUnreadable" },
  });
});

test("unreadable activity erase requires confirmation of lost pending recovery", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    view: "settings",
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
    view: "settings",
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
    view: "settings",
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

for (const view of ["activity", "settings"] as const) {
  test(`incompatible saved activity asks for an app update and exposes no erase action (${view})`, async ({
    page,
  }) => {
    await installNativeBoundary({
      page,
      view,
      snapshot: {
        ...SNAPSHOT,
        persistence: "deletionOnly",
        recordingStatus: "off",
        deletionStatus: "incompatible",
      },
    });
    await expect(
      page.getByText(enMessages.activity.incompatibleActivity, {
        exact: true,
      }),
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
}

test("healthy current activity shows incompatible history guidance and protects deletion", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    view: "settings",
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
  await installNativeBoundary({ page, view: "settings" });
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
    view: "settings",
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
    view: "settings",
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
  await openSuggestion(page, "Example matter");
  const callsBeforeCopy = await tauriInvocations(page);
  expect(callsBeforeCopy).not.toContainEqual(
    expect.objectContaining({ command: "activity_copy_text" }),
  );
  expect(callsBeforeCopy).not.toContainEqual(
    expect.objectContaining({ command: expect.stringContaining("clipboard_") }),
  );
  await suggestionCard(page, "Example matter")
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
      view: "settings",
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
  await installNativeBoundary({ page, view: "settings" });
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
  expect(await tauriInvocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "activity_set_capture_details" }),
  );
});

test("detail capture changes only on explicit choice in the welcome", async ({
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
});

test("detail capture is unchecked in the settings until chosen and can be turned off", async ({
  page,
}) => {
  await installNativeBoundary({ page, view: "settings" });
  const details = page.getByRole("checkbox", {
    name: enMessages.activity.captureDetails,
  });
  await expect(details).not.toBeChecked();
  await details.check();
  await expect(details).toBeChecked();
  expect(await tauriInvocations(page)).toContainEqual({
    command: "activity_set_capture_details",
    args: { enabled: true },
  });
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
    view: "settings",
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
    view: "settings",
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
    view: "settings",
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
      view: "settings",
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
  await expect(
    page.locator(ACTIVITY_BLOCKS).filter({ hasText: "memo.docx" }),
  ).toHaveCount(1);
  await expect(page.getByText(document)).toHaveCount(0);
  await openSuggestion(page, "Example matter");
  const card = suggestionCard(page, "Example matter");
  await expect(card.getByRole("tabpanel")).toContainText("memo.docx");
  await expect(card).not.toContainText(document);
  expect(await tauriInvocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "activity_copy_text" }),
  );
  await card
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
  await openSuggestion(page, "Example matter");
  const card = suggestionCard(page, "Example matter");
  await expect(card).toContainText("0.1 h");
  await expect(
    card.getByRole("button", { name: acceptName(enMessages) }),
  ).toBeEnabled();
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

const ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=";

const VISUALS_SNAPSHOT = {
  ...SNAPSHOT,
  sourceAppVisuals: [
    { key: "com.example.editor", iconDataUrl: ICON_DATA_URL, color: null },
  ],
  segments: [
    ...SNAPSHOT.segments,
    {
      appIdentifier: "com.example.viewer",
      appName: "Preview",
      start: "2026-10-07T10:00:00Z",
      end: "2026-10-07T10:30:00Z",
    },
  ],
} satisfies ActivityDaySnapshot;

test("the calendar reuses local app visuals and keeps a neutral fallback", async ({
  page,
}) => {
  await installNativeBoundary({ page, snapshot: VISUALS_SNAPSHOT });
  const blocks = page.locator(ACTIVITY_BLOCKS);
  await expect(
    blocks.filter({ hasText: "Example Editor" }).locator("img"),
  ).toHaveAttribute("src", ICON_DATA_URL);
  const fallback = blocks.filter({ hasText: "Preview" });
  await expect(fallback.locator("img")).toHaveCount(0);
  await expect(fallback.locator("svg").first()).toBeAttached();
});

test("hovering an Activity block lists its apps with time and title, then counts the rest", async ({
  page,
}) => {
  const apps = Array.from({ length: 7 }, (_, index) => ({
    appIdentifier: `com.example.app-${String(index)}`,
    appName: `App ${String(index)}`,
    windowTitle: `Window ${String(index)}`,
    // Longest first: app 0 has seven minutes, app 6 one.
    minutes: 7 - index,
  }));
  let minute = 0;
  const segments = apps.map(({ minutes, ...app }) => {
    const start = minute;
    minute += minutes;
    return {
      ...app,
      start: new Date(Date.UTC(2026, 9, 7, 9, start)).toISOString(),
      end: new Date(Date.UTC(2026, 9, 7, 9, minute)).toISOString(),
    };
  });
  await installNativeBoundary({
    page,
    snapshot: {
      ...SNAPSHOT,
      captureDetails: true,
      detailsAccess: "ready",
      segments,
    },
  });
  await page
    .locator(ACTIVITY_BLOCKS)
    .and(page.locator('[data-kind="mixed"]'))
    .hover();
  const details = page.locator('[data-slot="tooltip-popup"]');
  await expect(details).toBeVisible();
  for (const { appName, windowTitle } of apps.slice(0, 5)) {
    await expect(details).toContainText(appName);
    await expect(details).toContainText(windowTitle);
  }
  await expect(details).not.toContainText("App 5");
  await expect(details).toContainText(
    enMessages.activity.moreApps.replace("{count}", "2"),
  );
  await expect(details).toContainText(
    enMessages.activity.durationMinutes.replace("{minutes}", "7"),
  );
});

test("the settings app list reuses local app visuals and keeps a neutral fallback", async ({
  page,
}) => {
  const iconDataUrl = ICON_DATA_URL;
  await installNativeBoundary({
    page,
    view: "settings",
    snapshot: VISUALS_SNAPSHOT,
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
      preview.getByText(enMessages.activity.calendarHint, { exact: true }),
    ).toHaveCount(0);
    await expect(
      preview.getByRole("slider", {
        name: enMessages.activity.selectRange,
        includeHidden: true,
      }),
    ).toHaveCount(0);
    const matterSegments = preview.locator(
      '[data-column-id="activity"] [data-slot="day-calendar-block"]',
    );
    await expect(matterSegments).toHaveCount(previewApps.length);
    for (const segment of await matterSegments.all()) {
      expect(
        await segment.evaluate((element) =>
          element instanceof HTMLElement
            ? element.style.borderInlineStartColor
            : null,
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
      const timelineApp = preview
        .locator('[data-column-id="activity"] [data-slot="day-calendar-block"]')
        .filter({ hasText: appName });
      await expect(timelineApp.locator("img")).toHaveAttribute(
        "src",
        iconDataUrl,
      );
    }
  }
});

test("a suggestion card shows each app with its native icon", async ({
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
    },
  });
  await page.locator(SUGGESTION_BLOCKS).first().click();
  const card = suggestionCard(page, "Example matter");
  await card
    .getByRole("tab", { name: enMessages.activity.evidenceApps })
    .click();
  const app = card.getByRole("listitem").filter({ hasText: "Example Editor" });
  await expect(app.locator("img")).toHaveAttribute("src", iconDataUrl);
});

test("a call segment reads as a call in the calendar", async ({ page }) => {
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
  const blocks = page.locator(ACTIVITY_BLOCKS);
  const call = blocks.filter({ hasText: callLabel });
  await expect(call).toHaveCount(1);
  await expect(call).toHaveAttribute(
    "aria-label",
    new RegExp(`^${escapePattern(callLabel)}, `, "u"),
  );
  await expect(call.locator("svg.lucide-phone")).toHaveCount(1);
  const editor = blocks.filter({ hasText: "Example Editor" });
  await expect(editor.locator("svg.lucide-phone")).toHaveCount(0);
});

test("call recording is on by default and changes only on explicit choice", async ({
  page,
}) => {
  await installNativeBoundary({ page, view: "settings" });
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

test("suggestions render as dashed blocks and the day is triaged from the keyboard", async ({
  page,
}) => {
  await installNativeBoundary({ page, snapshot: TRIAGE_SNAPSHOT });
  const suggestions = page.locator(SUGGESTION_BLOCKS);
  await expect(suggestions).toHaveCount(4);
  await expect(suggestions.first()).toHaveClass(/border-dashed/u);
  await openSuggestion(page, "Example matter");
  await pressCardShortcut(page, "Enter");
  await expect(suggestionCard(page, "Second matter")).toBeFocused();
  expect(batchRequests(await tauriInvocations(page))).toEqual([
    {
      date: "2026-10-07",
      idempotencyKey: expect.any(String),
      items: [
        {
          entry: expect.objectContaining({
            matterId: "matter-1",
            durationMinutes: 30,
            narrative: "Work on Lease draft.docx",
            billable: true,
          }),
          ranges: [
            { start: "2026-10-07T09:00:00Z", end: "2026-10-07T09:30:00Z" },
          ],
        },
      ],
    },
  ]);
  await pressCardShortcut(page, "Backspace");
  await expect(suggestionCard(page, "Third matter")).toBeFocused();
  await expect(suggestions.filter({ hasText: "Second matter" })).toHaveCount(0);
  await expect(suggestions).toHaveCount(2);
  expect(batchRequests(await tauriInvocations(page))).toHaveLength(1);
  const card = suggestionCard(page, "Third matter");
  await expect(
    card.getByRole("button", { name: acceptName(enMessages) }),
  ).toContainText(/↩|Enter/u);
  await expect(
    card.getByRole("button", { name: rejectName(enMessages) }),
  ).toContainText(/⌫|Backspace/u);
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
});

for (const language of ["en", "ar"] as const) {
  test(`${language}: selecting a range in Time entries opens a card for that range`, async ({
    page,
  }) => {
    const messages = language === "ar" ? arMessages : enMessages;
    await installNativeBoundary({ page, language });
    // Activity is the record and takes no drag; entries are drawn where
    // they are kept.
    await expect(
      page.locator(
        '[data-column-id="activity"] [role="slider"][data-slot="day-calendar-surface"]',
      ),
    ).toHaveCount(0);
    const block = page.locator(ACTIVITY_BLOCKS).first();
    await block.scrollIntoViewIfNeeded();
    const box = await block.boundingBox();
    const entries = await page
      .locator('[data-column-id="entries"] [data-slot="day-calendar-surface"]')
      .boundingBox();
    if (!box || !entries) {
      throw new TypeError("The activity block and entries column need bounds");
    }
    // The suggestion covers the block's time in Time entries; the drag starts
    // in the empty time just after it and runs up across it.
    const x = entries.x + entries.width / 2;
    await page.mouse.move(x, box.y + box.height + 8);
    await page.mouse.down();
    await page.mouse.move(x, box.y + 3, { steps: 6 });
    await page.mouse.up();
    const card = suggestionCard(page, "Example matter");
    await expect(card).toBeFocused();
    await card.getByRole("button", { name: acceptName(messages) }).click();
    await expect(page.getByRole("status")).toBeVisible();
    expect(batchRequests(await tauriInvocations(page))).toEqual([
      expect.objectContaining({
        items: [
          expect.objectContaining({
            entry: expect.objectContaining({ matterId: "matter-1" }),
            ranges: [
              { start: "2026-10-07T09:00:00Z", end: "2026-10-07T09:30:00Z" },
            ],
          }),
        ],
      }),
    ]);

    const surface = page.getByRole("slider", {
      name: messages.activity.selectRange,
    });
    await surface.focus();
    await surface.press("ArrowDown");
    await surface.press("Enter");
    const empty = suggestionCard(page, messages.activity.newEntry);
    await expect(empty).toBeFocused();
    await expect(empty).toContainText(messages.activity.rangeEmpty);
    await expect(
      empty.getByRole("button", { name: acceptName(messages) }),
    ).toBeDisabled();
  });
}

const draftInvocations = async (page: Page) =>
  (await tauriInvocations(page)).filter(
    ({ command }) => command === "billing_draft_create_confirmed",
  );

test("a card asks for consent once, then drafts its description and shows the earlier entry it follows", async ({
  page,
}) => {
  await installNativeBoundary({ page, snapshot: TRIAGE_SNAPSHOT });
  await openSuggestion(page, "Example matter");
  const card = suggestionCard(page, "Example matter");
  await expect(
    card.getByText(enMessages.activity.aiDraftConsent),
  ).toBeVisible();
  // Nothing is drafted before the user allows it.
  expect(await draftInvocations(page)).toEqual([]);
  await card
    .getByRole("button", { name: enMessages.activity.aiDraftAllow })
    .click();
  await expect(
    card.getByRole("textbox", { name: enMessages.activity.entryNarrative }),
  ).toHaveValue(GENERATED_NARRATIVE);
  expect(await tauriInvocations(page)).toContainEqual({
    command: "billing_draft_grant_consent",
    args: {
      scopeKey: '["org_fixture","user_fixture"]',
      revision: "revision-1",
    },
  });
  const [draft] = await draftInvocations(page);
  // Only the entry's matter, date, duration, app names and, as titles are
  // recorded, the names the card shows are sent.
  expect(draft?.args).toEqual({
    request: {
      entries: [
        {
          entryId: "entry_1",
          matterId: expect.any(String),
          date: TRIAGE_SNAPSHOT.date,
          timezone: expect.any(String),
          durationMinutes: expect.any(Number),
          appNames: ["Example Editor"],
          evidence: { documentNames: [], windowTitles: ["Lease draft.docx"] },
        },
      ],
    },
  });
  await expect(card.getByText(enMessages.activity.aiDraftConsent)).toHaveCount(
    0,
  );
  // The English plural for one earlier entry.
  await card.getByRole("button", { name: "Follows 1 earlier entry" }).click();
  await expect(card.getByText(EARLIER_ENTRY.narrative)).toBeVisible();
  // The next card drafts as it opens: consent is asked once.
  await pressCardShortcut(page, "Backspace");
  const next = suggestionCard(page, "Second matter");
  await expect(next).toBeFocused();
  await expect(
    next.getByRole("textbox", { name: enMessages.activity.entryNarrative }),
  ).toHaveValue(GENERATED_NARRATIVE);
  await expect(page.getByText(enMessages.activity.aiDraftConsent)).toHaveCount(
    0,
  );
  expect(await draftInvocations(page)).toHaveLength(2);
});

test("an accepted drafted entry carries the drafted description", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: TRIAGE_SNAPSHOT,
    drafting: { ...DRAFTING, consent: "granted" },
  });
  await openSuggestion(page, "Example matter");
  const card = suggestionCard(page, "Example matter");
  await expect(
    card.getByRole("textbox", { name: enMessages.activity.entryNarrative }),
  ).toHaveValue(GENERATED_NARRATIVE);
  await pressCardShortcut(page, "Enter");
  await expect(suggestionCard(page, "Second matter")).toBeFocused();
  expect(batchRequests(await tauriInvocations(page))).toEqual([
    expect.objectContaining({
      items: [
        expect.objectContaining({
          entry: expect.objectContaining({ narrative: GENERATED_NARRATIVE }),
        }),
      ],
    }),
  ]);
});

test("text typed while a draft is written is kept over the draft", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: TRIAGE_SNAPSHOT,
    drafting: { ...DRAFTING, consent: "granted", held: true },
  });
  await openSuggestion(page, "Example matter");
  const card = suggestionCard(page, "Example matter");
  await expect(
    card.getByText(enMessages.activity.aiDraftWriting),
  ).toBeVisible();
  const narrative = card.getByRole("textbox", {
    name: enMessages.activity.entryNarrative,
  });
  await narrative.fill("My own words");
  await releaseDraft(page);
  await expect(card.getByText(enMessages.activity.aiDraftWriting)).toHaveCount(
    0,
  );
  await expect(
    card.getByRole("button", { name: enMessages.activity.aiDraftAgain }),
  ).toBeVisible();
  await expect(narrative).toHaveValue("My own words");
  // Asking again replaces the description with a new draft.
  await card
    .getByRole("button", { name: enMessages.activity.aiDraftAgain })
    .click();
  await releaseDraft(page);
  await expect(narrative).toHaveValue(GENERATED_NARRATIVE);
  expect(await draftInvocations(page)).toHaveLength(2);
});

test("a guided draft shows its codes and guideline notes, and the accepted entry carries its classification", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: TRIAGE_SNAPSHOT,
    drafting: { ...DRAFTING, mode: "guided", consent: "granted" },
  });
  await openSuggestion(page, "Example matter");
  const card = suggestionCard(page, "Example matter");
  await expect(card.getByText("Task L120 · Activity A104")).toBeVisible();
  const notes = card.getByRole("region", {
    name: enMessages.activity.aiDraftFlags,
  });
  await expect(notes).toContainText("List each task separately.");
  await expect(notes).toContainText("Outside counsel guidelines.pdf, 4.2");
  await pressCardShortcut(page, "Enter");
  await expect(suggestionCard(page, "Second matter")).toBeFocused();
  expect(batchRequests(await tauriInvocations(page))).toEqual([
    expect.objectContaining({
      items: [
        expect.objectContaining({
          entry: expect.objectContaining({
            narrative: GENERATED_NARRATIVE,
            classification: {
              type: "ledes",
              taskCode: "L120",
              activityCode: "A104",
            },
          }),
        }),
      ],
    }),
  ]);
});

test("a guided split creates its parts as entries, each over its own share of the time", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: TRIAGE_SNAPSHOT,
    drafting: {
      ...DRAFTING,
      mode: "guided",
      consent: "granted",
      flagFix: "split",
      operations: [
        {
          type: "split",
          parts: [10, 20].map((durationMinutes, index) => ({
            durationMinutes,
            narrative: `Part ${String(index + 1)}`,
            classification: {
              type: "ledes",
              taskCode: "L120",
              activityCode: "A104",
            },
            billable: true,
          })),
        },
      ],
    },
  });
  await openSuggestion(page, "Example matter");
  const card = suggestionCard(page, "Example matter");
  const proposal = card.getByRole("region", {
    name: "stella AI suggests splitting this into 2 entries",
  });
  await expect(proposal).toContainText("Part 1");
  await expect(proposal).toContainText("Part 2");
  // Nothing is created until the split is accepted.
  expect(batchRequests(await tauriInvocations(page))).toEqual([]);
  await card
    .getByRole("region", { name: enMessages.activity.aiDraftFlags })
    .getByRole("button", { name: enMessages.activity.aiFlagSplit })
    .click();
  await expect(suggestionCard(page, "Second matter")).toBeFocused();
  const [batch] = batchRequests(await tauriInvocations(page));
  expect(batch).toEqual(
    expect.objectContaining({
      items: [
        {
          entry: expect.objectContaining({
            matterId: "matter-1",
            durationMinutes: 10,
            narrative: "Part 1",
          }),
          ranges: [
            { start: "2026-10-07T09:00:00Z", end: "2026-10-07T09:10:00Z" },
          ],
        },
        {
          entry: expect.objectContaining({
            matterId: "matter-1",
            durationMinutes: 20,
            narrative: "Part 2",
          }),
          ranges: [
            { start: "2026-10-07T09:10:00Z", end: "2026-10-07T09:30:00Z" },
          ],
        },
      ],
    }),
  );
});

/** A matter the server named from the firm's records, outside the card's
 * candidates. */
const OTHER_CLIENT_MATTER_ID = "00000000-0000-4000-8000-0000000000b2";

test("a guided move of part of the time keeps the rest on the card's matter", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: TRIAGE_SNAPSHOT,
    drafting: {
      ...DRAFTING,
      mode: "guided",
      consent: "granted",
      operations: [
        {
          type: "move",
          targetMatterId: OTHER_CLIENT_MATTER_ID,
          targetMatterName: "Other client matter",
          durationMinutes: 10,
          narrative: "Called about the service agreement.",
          classification: { type: "activity_group", activityGroup: "client" },
          billable: false,
        },
      ],
    },
  });
  await openSuggestion(page, "Example matter");
  const card = suggestionCard(page, "Example matter");
  const proposal = card.getByRole("region", {
    name: /Other client matter/u,
  });
  await expect(proposal).toContainText("Called about the service agreement.");
  await proposal
    .getByRole("button", { name: enMessages.activity.aiStructureMoveAccept })
    .click();
  await expect(suggestionCard(page, "Second matter")).toBeFocused();
  const [batch] = batchRequests(await tauriInvocations(page));
  expect(batch).toEqual(
    expect.objectContaining({
      items: [
        {
          entry: expect.objectContaining({
            matterId: "matter-1",
            durationMinutes: 20,
            narrative: GENERATED_NARRATIVE,
            billable: true,
          }),
          ranges: [
            { start: "2026-10-07T09:00:00Z", end: "2026-10-07T09:20:00Z" },
          ],
        },
        {
          entry: expect.objectContaining({
            matterId: OTHER_CLIENT_MATTER_ID,
            durationMinutes: 10,
            narrative: "Called about the service agreement.",
            billable: false,
            classification: {
              type: "activity_group",
              activityGroup: "client",
            },
          }),
          ranges: [
            { start: "2026-10-07T09:20:00Z", end: "2026-10-07T09:30:00Z" },
          ],
        },
      ],
    }),
  );
});

test("a split proposed for one matter is not offered once the card's matter changes", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: TRIAGE_SNAPSHOT,
    drafting: {
      ...DRAFTING,
      mode: "guided",
      consent: "granted",
      operations: [
        {
          type: "split",
          parts: [15, 15].map((durationMinutes) => ({
            durationMinutes,
            narrative: "Half",
            classification: {
              type: "ledes",
              taskCode: "L120",
              activityCode: "A104",
            },
            billable: true,
          })),
        },
      ],
    },
  });
  await openSuggestion(page, "Example matter");
  const card = suggestionCard(page, "Example matter");
  const proposal = card.getByRole("region", {
    name: "stella AI suggests splitting this into 2 entries",
  });
  await expect(proposal).toBeVisible();
  await card.getByRole("button", { name: "Example matter" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Second matter/u })
    .click();
  await expect(proposal).toHaveCount(0);
});

test("choosing another matter drops a guided draft's codes", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: TRIAGE_SNAPSHOT,
    drafting: { ...DRAFTING, mode: "guided", consent: "granted" },
  });
  await openSuggestion(page, "Example matter");
  const card = suggestionCard(page, "Example matter");
  await expect(card.getByText("Task L120 · Activity A104")).toBeVisible();
  await card.getByRole("button", { name: "Example matter" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Second matter/u })
    .click();
  await expect(page.getByText("Task L120 · Activity A104")).toHaveCount(0);
});

test("refining a draft proposes the change, accepting applies it and Undo restores the draft", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: TRIAGE_SNAPSHOT,
    drafting: { ...DRAFTING, consent: "granted" },
  });
  await openSuggestion(page, "Example matter");
  const card = suggestionCard(page, "Example matter");
  const narrative = card.getByRole("textbox", {
    name: enMessages.activity.entryNarrative,
  });
  await expect(narrative).toHaveValue(GENERATED_NARRATIVE);
  await card
    .getByRole("button", { name: enMessages.activity.aiSteerShorter })
    .click();
  await card
    .getByRole("button", { name: enMessages.activity.aiRefine, exact: true })
    .click();
  const proposal = card.getByRole("region", {
    name: enMessages.activity.aiProposal,
  });
  await expect(proposal).toBeVisible();
  // The proposal reads as a change to the draft until it is accepted.
  expect(
    (await proposal.getByRole("deletion").allTextContents()).join(""),
  ).toBe("draft and its annexes.");
  expect(
    (await proposal.getByRole("insertion").allTextContents()).join(""),
  ).toBe("draft.");
  await expect(narrative).toHaveValue(GENERATED_NARRATIVE);
  const [, refined] = await draftInvocations(page);
  // The instruction goes with the entry and the server's first result, sent
  // back as it came.
  expect(refined?.args).toEqual({
    request: {
      entries: [expect.objectContaining({ entryId: "entry_1" })],
      steer: enMessages.activity.aiSteerShorter,
      previousResult: {
        mode: "plain",
        drafts: [
          {
            entryId: "entry_1",
            narrative: GENERATED_NARRATIVE,
            matchedEarlierEntryIds: [EARLIER_ENTRY.id],
          },
        ],
      },
    },
  });
  await proposal
    .getByRole("button", { name: enMessages.activity.aiAccept })
    .click();
  await expect(narrative).toHaveValue(REFINED_NARRATIVE);
  await card.getByRole("button", { name: enMessages.activity.aiUndo }).click();
  await expect(narrative).toHaveValue(GENERATED_NARRATIVE);
});

test("dismissing a proposal keeps the draft, and Use original brings back the template", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: TRIAGE_SNAPSHOT,
    drafting: { ...DRAFTING, consent: "granted" },
  });
  await openSuggestion(page, "Example matter");
  const card = suggestionCard(page, "Example matter");
  const narrative = card.getByRole("textbox", {
    name: enMessages.activity.entryNarrative,
  });
  await expect(narrative).toHaveValue(GENERATED_NARRATIVE);
  await card
    .getByRole("textbox", { name: enMessages.activity.aiRefinePlaceholder })
    .fill("Mention the annex numbers");
  await card
    .getByRole("button", { name: enMessages.activity.aiRefine, exact: true })
    .click();
  await card
    .getByRole("region", { name: enMessages.activity.aiProposal })
    .getByRole("button", { name: enMessages.activity.aiDismiss })
    .click();
  await expect(narrative).toHaveValue(GENERATED_NARRATIVE);
  await card
    .getByRole("button", { name: enMessages.activity.aiUseOriginal })
    .click();
  await expect(narrative).toHaveValue("Work on Lease draft.docx");
});

test("an instruction remembered while refining becomes the drafting preference", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: TRIAGE_SNAPSHOT,
    drafting: { ...DRAFTING, consent: "granted" },
  });
  await openSuggestion(page, "Example matter");
  const card = suggestionCard(page, "Example matter");
  await expect(
    card.getByRole("textbox", { name: enMessages.activity.entryNarrative }),
  ).toHaveValue(GENERATED_NARRATIVE);
  await card
    .getByRole("button", { name: enMessages.activity.aiSteerShorter })
    .click();
  await card
    .getByRole("checkbox", { name: enMessages.activity.aiSteerRemember })
    .click();
  await card
    .getByRole("button", { name: enMessages.activity.aiRefine, exact: true })
    .click();
  await expect
    .poll(async () =>
      (await tauriInvocations(page)).filter(
        ({ command }) => command === "billing_draft_set_preference",
      ),
    )
    .toEqual([
      {
        command: "billing_draft_set_preference",
        args: {
          scopeKey: '["org_fixture","user_fixture"]',
          revision: "revision-1",
          preference: enMessages.activity.aiSteerShorter,
        },
      },
    ]);
});

test("Settings shows the remembered drafting preference and forgets it", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    view: "settings",
    drafting: { ...DRAFTING, consent: "granted", preference: "Shorter" },
  });
  await expect(
    page.getByText(enMessages.activity.billingDraftsPreference),
  ).toBeVisible();
  await expect(page.getByText("Shorter", { exact: true })).toBeVisible();
  await page
    .getByRole("button", {
      name: enMessages.activity.billingDraftsForgetPreference,
    })
    .click();
  await expect(
    page.getByText(enMessages.activity.billingDraftsPreference),
  ).toHaveCount(0);
  expect(await tauriInvocations(page)).toContainEqual({
    command: "billing_draft_set_preference",
    args: {
      scopeKey: '["org_fixture","user_fixture"]',
      revision: "revision-1",
      preference: null,
    },
  });
});

test("a failed draft keeps the template and offers to try again", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: TRIAGE_SNAPSHOT,
    drafting: { ...DRAFTING, consent: "granted", generation: "fail" },
  });
  await openSuggestion(page, "Example matter");
  const card = suggestionCard(page, "Example matter");
  await expect(card.getByText(enMessages.activity.aiDraftFailed)).toBeVisible();
  await expect(
    card.getByRole("textbox", { name: enMessages.activity.entryNarrative }),
  ).toHaveValue("Work on Lease draft.docx");
  await expect(
    card.getByRole("button", { name: enMessages.activity.aiDraftRetry }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: acceptName(enMessages) }),
  ).toBeEnabled();
});

test("with drafting switched off for the firm, a card offers no stella AI and sends nothing", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    snapshot: TRIAGE_SNAPSHOT,
    drafting: { ...DRAFTING, mode: "off", consent: "granted" },
  });
  await openSuggestion(page, "Example matter");
  const card = suggestionCard(page, "Example matter");
  await expect(card).toBeFocused();
  await expect(card.getByText(enMessages.activity.aiDraftConsent)).toHaveCount(
    0,
  );
  await expect(
    card.getByRole("button", { name: enMessages.activity.aiDraftWrite }),
  ).toHaveCount(0);
  expect(await draftInvocations(page)).toEqual([]);
});

test("Settings withdraws consent to stella AI drafts and sends nothing else", async ({
  page,
}) => {
  await installNativeBoundary({
    page,
    view: "settings",
    drafting: { ...DRAFTING, consent: "granted" },
  });
  await expect(
    page.getByText(enMessages.activity.billingDraftsGranted),
  ).toBeVisible();
  await page
    .getByRole("button", { name: enMessages.activity.billingDraftsWithdraw })
    .click();
  await expect(
    page.getByText(enMessages.activity.billingDraftsRevoked),
  ).toBeVisible();
  expect(await tauriInvocations(page)).toContainEqual({
    command: "billing_draft_withdraw_consent",
    args: { scopeKey: '["org_fixture","user_fixture"]' },
  });
  expect(await draftInvocations(page)).toEqual([]);
});
