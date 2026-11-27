import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type {
  DesktopMatterCandidatesResponse,
  DesktopTimeEntryMatterCandidate,
} from "@stll/api-contract/desktop-time-entries";

import type { ActivityDaySnapshot } from "../src/activity/activity-types";

GlobalRegistrator.register({ url: "http://localhost/" });

const testing = await import("@testing-library/react");
const { DesktopIntlProvider, defaultMessages } = await import("../src/i18n");
const { ActivityDayCalendar } =
  await import("../src/activity/ActivityDayCalendar");
const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");

/** One macrotask, for React's scheduler and the mocked IPC answers. */
const nextMacrotask = async () =>
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

afterEach(async () => {
  await testing.act(nextMacrotask);
  testing.cleanup();
  clearMocks();
  localStorage.clear();
});

afterAll(async () => {
  await nextMacrotask();
  await GlobalRegistrator.unregister();
});

const messages = defaultMessages.activity;
const MATTER = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Riverside lease renewal",
  reference: "RL-7",
  color: null,
  clientName: "Riverside tenants",
  signals: {
    lastWorkedAt: null,
    newlyAssignedAt: null,
    upcomingDeadline: null,
  },
} satisfies DesktopTimeEntryMatterCandidate;

/** A day whose only matter was recorded for a minute: a brief touch. */
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
  calendarSource: "off",
  detectCalls: true,
  appNameOnlyApps: [],
  browserApps: [],
  sourceAppVisuals: [],
  browserTitleApps: [],
  browserTitlesManaged: false,
  detailsAccess: "disabled",
  persistence: "encrypted",
  recordingStatus: "recording",
  retention: "month",
  segments: [
    {
      appIdentifier: "com.example.editor",
      appName: "Example Editor",
      matterId: MATTER.id,
      start: "2026-10-07T09:00:00Z",
      end: "2026-10-07T09:01:00Z",
    },
  ],
  today: "2026-10-07",
  unreadable: false,
  gaps: [],
  outages: { status: "read", outages: [] },
  stoppedReason: null,
} satisfies ActivityDaySnapshot;

const CANDIDATES = {
  matters: [MATTER],
  timeMinimumUnitMinutes: 6,
} satisfies DesktopMatterCandidatesResponse;

const noop = () => undefined;

const renderDay = async (snapshot: ActivityDaySnapshot) => {
  mockIPC((command) => {
    switch (command) {
      case "time_entry_candidates":
        return CANDIDATES;
      case "time_entry_resolve_matters":
        return [];
      case "activity_get_matter_learning":
        return { type: "unavailable" };
      case "time_entry_day_entries":
        return { entries: [] };
      default:
        return null;
    }
  });
  const view = testing.render(
    <DesktopIntlProvider language="en" messages={defaultMessages}>
      <ActivityDayCalendar
        header={null}
        snapshot={snapshot}
        preferences={{ granularity: 15 }}
        onPreferencesChange={noop}
        onCopy={noop}
        onCaptureCommand={noop}
        onOpenDayTime={noop}
        onReviewStatusChange={noop}
      />
    </DesktopIntlProvider>,
  );
  await testing.act(nextMacrotask);
  return view;
};

/** The brief touch's one action, once the matters have arrived. */
const addBriefTouch = async (view: ReturnType<typeof testing.render>) =>
  await testing.waitFor(() =>
    view.getByRole("button", {
      name: (name) =>
        name.startsWith(messages.addBriefTouch.split("{duration}")[0] ?? ""),
    }),
  );

test("a brief touch can be added while Activity records", async () => {
  const view = await renderDay(SNAPSHOT);
  expect((await addBriefTouch(view)).getAttribute("aria-disabled")).not.toBe(
    "true",
  );
});

test("while Activity cannot record, a brief touch cannot be added", async () => {
  const view = await renderDay({ ...SNAPSHOT, stoppedReason: "signedOut" });
  const button = await addBriefTouch(view);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  testing.fireEvent.click(button);
  await testing.act(nextMacrotask);
  // Nothing opened: the brief touch is still listed and no card took it.
  expect(await addBriefTouch(view)).toBe(button);
});

test("a stored retry goes back to editing once its pending batch is gone", async () => {
  mockIPC((command) => {
    switch (command) {
      case "time_entry_candidates":
        return CANDIDATES;
      case "time_entry_resolve_matters":
        return [];
      case "activity_get_matter_learning":
        return { type: "unavailable" };
      default:
        return null;
    }
  });
  const statuses: string[] = [];
  const day = (snapshot: ActivityDaySnapshot) => (
    <DesktopIntlProvider language="en" messages={defaultMessages}>
      <ActivityDayCalendar
        header={null}
        snapshot={snapshot}
        preferences={{ granularity: 15 }}
        onPreferencesChange={noop}
        onCopy={noop}
        onCaptureCommand={noop}
        onOpenDayTime={noop}
        onReviewStatusChange={(status) => {
          statuses.push(status);
        }}
      />
    </DesktopIntlProvider>
  );
  const pending = {
    ...SNAPSHOT,
    pendingBatch: {
      idempotencyKey: "batch-1",
      entries: [
        {
          matterId: MATTER.id,
          dateWorked: "2026-10-07",
          timezoneId: "UTC",
          durationMinutes: 6,
          narrative: "Lease review",
          billable: true,
        },
      ],
      ranges: [
        [{ start: "2026-10-07T09:00:00Z", end: "2026-10-07T09:01:00Z" }],
      ],
    },
  } satisfies ActivityDaySnapshot;
  const view = testing.render(day(pending));
  await testing.act(nextMacrotask);
  expect(statuses.at(-1)).toBe("retry");

  // Sent from another window, or discarded in settings: the snapshot no
  // longer carries the batch.
  view.rerender(day(SNAPSHOT));
  await testing.act(nextMacrotask);
  expect(statuses.at(-1)).toBe("editing");
  expect(statuses).not.toContain("submitting");
});
