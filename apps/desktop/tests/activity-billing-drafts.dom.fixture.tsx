import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import { DESKTOP_BILLING_DRAFT_LIMITS } from "@stll/api-contract/desktop-billing-drafts";
import type {
  DesktopBillingDraftResponse,
  DesktopBillingDraftReview,
} from "@stll/api-contract/desktop-billing-drafts";
import type {
  DesktopTimeEntryClassification,
  DesktopTimeEntryMatterCandidate,
} from "@stll/api-contract/desktop-time-entries";
import { Temporal } from "@stll/time";

import type { ActivityDaySnapshot } from "../src/activity/activity-types";

GlobalRegistrator.register({ url: "http://localhost/" });

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { clearMocks, mockIPC, mockWindows } =
  await import("@tauri-apps/api/mocks");
const { ActivityDayReview } = await import("../src/activity/ActivityDayReview");
const { DesktopIntlProvider, defaultMessages: messages } =
  await import("../src/i18n");

const FIRST_MATTER_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_MATTER_ID = "00000000-0000-4000-8000-000000000002";
const DAY = "2026-10-07";
const CLIENT_CLASSIFICATION = {
  type: "activity_group",
  activityGroup: "client",
} as const;
const BASE_LEDGER_CLASSIFICATION = {
  type: "ledes",
  taskCode: "BASE-TASK",
  activityCode: "BASE-ACTIVITY",
} as const satisfies DesktopTimeEntryClassification;
const FIRST_OPERATION_CLASSIFICATION = {
  type: "ledes",
  taskCode: "TASK-101",
  activityCode: "ACT-201",
} as const satisfies DesktopTimeEntryClassification;
const SECOND_OPERATION_CLASSIFICATION = {
  type: "ledes",
  taskCode: "TASK-102",
  activityCode: "ACT-202",
} as const satisfies DesktopTimeEntryClassification;

const candidates = [
  {
    id: FIRST_MATTER_ID,
    name: "Source matter",
    reference: "M-001",
    color: "--option-emerald",
    clientName: "Client one",
    signals: {
      lastWorkedAt: DAY,
      newlyAssignedAt: null,
      upcomingDeadline: null,
    },
  },
  {
    id: SECOND_MATTER_ID,
    name: "Target matter",
    reference: "M-002",
    color: "--option-blue",
    clientName: "Client two",
    signals: {
      lastWorkedAt: DAY,
      newlyAssignedAt: null,
      upcomingDeadline: null,
    },
  },
] satisfies DesktopTimeEntryMatterCandidate[];

const segments = [
  {
    appIdentifier: "com.example.editor",
    appName: "Example Editor",
    matterId: FIRST_MATTER_ID,
    start: "2026-10-07T09:00:00Z",
    end: "2026-10-07T10:00:00Z",
  },
];

const snapshot = (activitySegments = segments): ActivityDaySnapshot => ({
  date: DAY,
  pendingBatch: null,
  deletionStatus: "available",
  manualAssignments: [],
  draftedEntries: [],
  timeBillingEnabled: true,
  earliestDate: DAY,
  latestDate: DAY,
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
  segments: activitySegments,
  today: DAY,
  unreadable: false,
});

const billingDrafts = {
  settings: { type: "ready", consent: "granted", preference: null },
  setConsent: async () => await Promise.resolve(true),
  setPreference: async () => await Promise.resolve(true),
} as const;

type DeferredReview = {
  request: unknown;
  deferred: ReturnType<typeof Promise.withResolvers<unknown>>;
};

const installNativeBoundary = (matterCandidates = candidates) => {
  const draftRequests: DeferredReview[] = [];
  const submissions: unknown[] = [];
  mockWindows("activity");
  mockIPC(
    async (command, args) => {
      switch (command) {
        case "time_entry_candidates":
          return matterCandidates;
        case "billing_draft_create_confirmed": {
          const deferred = Promise.withResolvers<unknown>();
          const request =
            args &&
            !Array.isArray(args) &&
            !(args instanceof ArrayBuffer) &&
            !(args instanceof Uint8Array)
              ? args["request"]
              : undefined;
          draftRequests.push({ request, deferred });
          return await deferred.promise;
        }
        case "time_entry_submit_batch_confirmed": {
          const request =
            args &&
            !Array.isArray(args) &&
            !(args instanceof ArrayBuffer) &&
            !(args instanceof Uint8Array)
              ? args["request"]
              : undefined;
          submissions.push(request);
          const items: unknown[] =
            typeof request === "object" &&
            request !== null &&
            "items" in request &&
            Array.isArray(request.items)
              ? request.items
              : [];
          return {
            entries: items.map((_, index) => ({ id: `entry-${index + 1}` })),
            markerSaved: true,
          };
        }
        case "desktop_report_error":
          return undefined;
        default:
          return panic("Unexpected desktop command", command);
      }
    },
    { shouldMockEvents: true },
  );
  return { draftRequests, submissions };
};

const mountReview = (day = snapshot()) =>
  render(
    <DesktopIntlProvider language="en" messages={messages}>
      <ActivityDayReview
        snapshot={day}
        header={<span>Review</span>}
        billingDrafts={billingDrafts}
        onCopy={(_text, onSettled) => onSettled(true)}
        onReviewStatusChange={() => undefined}
      />
    </DesktopIntlProvider>,
  );

const draft = (
  entryId: string,
  narrative: string,
  operations: DesktopBillingDraftResponse["drafts"][number]["operations"] = [],
  classification: DesktopTimeEntryClassification = CLIENT_CLASSIFICATION,
) => ({
  entryId,
  narrative,
  classification,
  flags: [],
  matchedEarlierEntryIds: [],
  operations,
});

const review = (
  drafts: DesktopBillingDraftReview["result"]["drafts"],
): DesktopBillingDraftReview => ({
  result: { drafts, checkedGuidelines: [] },
  earlierEntries: [],
});

const firstDraftRequest = (requests: readonly DeferredReview[]) =>
  requests.at(0) ?? panic("Expected billing draft request");

const visibleReviewCodes = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[id^="review-item-"]'), (item) =>
    Array.from(item.querySelectorAll("code"), (code) => code.textContent),
  );

const resolveDraft = async (request: DeferredReview, value: unknown) => {
  await act(async () => {
    request.deferred.resolve(value);
    await request.deferred.promise;
    await Promise.resolve();
  });
};

const startDrafting = async (
  view: ReturnType<typeof mountReview>,
  requests: readonly DeferredReview[],
) => {
  await waitFor(() => expect(view.getByText("Example Editor")).toBeTruthy());
  fireEvent.click(
    view.getByRole("button", { name: messages.activity.aiDraft }),
  );
  await waitFor(() => expect(requests).toHaveLength(1));
  return firstDraftRequest(requests);
};

afterEach(async () => {
  await act(async () => {
    cleanup();
    await Promise.resolve();
  });
  clearMocks();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("accepted split content can be edited and the confirmed payload uses those rows", async () => {
  const boundary = installNativeBoundary();
  const view = mountReview();
  const request = await startDrafting(view, boundary.draftRequests);
  await resolveDraft(
    request,
    review([
      draft(
        "entry_1",
        "Draft narrative",
        [
          {
            type: "split",
            parts: [
              {
                durationMinutes: 30,
                narrative: "First part",
                classification: FIRST_OPERATION_CLASSIFICATION,
                billable: true,
              },
              {
                durationMinutes: 30,
                narrative: "Second part",
                classification: SECOND_OPERATION_CLASSIFICATION,
                billable: false,
              },
            ],
          },
        ],
        BASE_LEDGER_CLASSIFICATION,
      ),
    ]),
  );

  fireEvent.click(
    view.getByRole("button", { name: messages.activity.aiApply }),
  );
  expect(visibleReviewCodes(view.container)).toEqual([
    ["TASK-101", "ACT-201"],
    ["TASK-102", "ACT-202"],
  ]);
  const narratives = view.getAllByRole("textbox", {
    name: messages.activity.entryNarrative,
  });
  expect(narratives).toHaveLength(2);
  fireEvent.change(narratives.at(1) ?? panic("Expected second split part"), {
    target: { value: "Edited second part" },
  });
  fireEvent.click(view.getByRole("button", { name: "Create 2 drafts" }));

  await waitFor(() => expect(boundary.submissions).toHaveLength(1));
  const submission = boundary.submissions.at(0);
  expect(submission).toMatchObject({
    items: [
      {
        entry: {
          matterId: FIRST_MATTER_ID,
          durationMinutes: 30,
          narrative: "First part",
          billable: true,
          classification: FIRST_OPERATION_CLASSIFICATION,
        },
      },
      {
        entry: {
          matterId: FIRST_MATTER_ID,
          durationMinutes: 30,
          narrative: "Edited second part",
          billable: false,
          classification: SECOND_OPERATION_CLASSIFICATION,
        },
      },
    ],
  });
});

test("classification changes are shown and submitted from the operation", async () => {
  const boundary = installNativeBoundary();
  const view = mountReview();
  const request = await startDrafting(view, boundary.draftRequests);
  await resolveDraft(
    request,
    review([
      draft(
        "entry_1",
        "Classified work",
        [
          {
            type: "change_classification",
            classification: FIRST_OPERATION_CLASSIFICATION,
          },
        ],
        BASE_LEDGER_CLASSIFICATION,
      ),
    ]),
  );

  expect(visibleReviewCodes(view.container)).toEqual([["TASK-101", "ACT-201"]]);
  fireEvent.click(view.getByRole("button", { name: "Create 1 draft" }));

  await waitFor(() => expect(boundary.submissions).toHaveLength(1));
  expect(boundary.submissions.at(0)).toMatchObject({
    items: [
      {
        entry: {
          matterId: FIRST_MATTER_ID,
          narrative: "Classified work",
          classification: FIRST_OPERATION_CLASSIFICATION,
        },
      },
    ],
  });
});

test("accepted merge keeps edits across deselection and reselects as one submitted item", async () => {
  const boundary = installNativeBoundary();
  const firstSegment =
    segments.at(0) ?? panic("Expected source activity segment");
  const secondSegment = {
    ...firstSegment,
    matterId: SECOND_MATTER_ID,
    start: "2026-10-07T10:00:00Z",
    end: "2026-10-07T10:30:00Z",
  };
  const view = mountReview(snapshot([...segments, secondSegment]));
  const request = await startDrafting(view, boundary.draftRequests);
  await resolveDraft(
    request,
    review([
      draft("entry_1", "Combined work", [
        {
          type: "merge",
          entryIds: ["entry_1", "entry_2"],
          narrative: "Combined work",
          classification: CLIENT_CLASSIFICATION,
          billable: true,
        },
      ]),
      draft("entry_2", "Second source"),
    ]),
  );

  fireEvent.click(
    view.getByRole("button", { name: messages.activity.aiApply }),
  );
  const refineButtons = view.getAllByRole("button", {
    name: messages.activity.aiRefine,
  });
  expect(refineButtons).toHaveLength(1);
  expect(refineButtons.at(0)).toHaveProperty("disabled", true);
  expect(
    view.queryByPlaceholderText(messages.activity.aiSteerAllPlaceholder),
  ).toBeNull();
  const merged = view.getByRole("textbox", {
    name: messages.activity.entryNarrative,
  });
  fireEvent.change(merged, { target: { value: "Edited combined work" } });
  const secondMatter = view.getByRole("checkbox", {
    name: messages.activity.includeMatter.replace("{matter}", "Target matter"),
  });
  fireEvent.click(secondMatter);
  expect(
    view.getByRole("textbox", { name: messages.activity.entryNarrative }),
  ).toBeTruthy();
  fireEvent.click(secondMatter);
  expect(
    view.getByRole("textbox", { name: messages.activity.entryNarrative }),
  ).toHaveProperty("value", "Edited combined work");
  fireEvent.click(view.getByRole("button", { name: "Create 1 draft" }));

  await waitFor(() => expect(boundary.submissions).toHaveLength(1));
  expect(boundary.submissions.at(0)).toMatchObject({
    items: [
      {
        entry: {
          matterId: FIRST_MATTER_ID,
          durationMinutes: 90,
          narrative: "Edited combined work",
          billable: true,
        },
      },
    ],
  });
});

test("accepted move can be undone and its edited source and target rows are submitted", async () => {
  const boundary = installNativeBoundary();
  const view = mountReview();
  const request = await startDrafting(view, boundary.draftRequests);
  await resolveDraft(
    request,
    review([
      draft("entry_1", "Starting narrative", [
        {
          type: "move",
          targetMatterId: SECOND_MATTER_ID,
          targetMatterName: "Target matter",
          durationMinutes: 30,
          narrative: "Moved narrative",
          classification: CLIENT_CLASSIFICATION,
          billable: true,
        },
      ]),
    ]),
  );

  fireEvent.click(
    view.getByRole("button", { name: messages.activity.aiApply }),
  );
  expect(
    view.getByRole("button", { name: messages.activity.aiRefine }),
  ).toHaveProperty("disabled", true);
  let narratives = view.getAllByRole("textbox", {
    name: messages.activity.entryNarrative,
  });
  expect(narratives).toHaveLength(2);
  fireEvent.click(view.getByRole("button", { name: messages.activity.aiUndo }));
  expect(
    view.getByRole("textbox", { name: messages.activity.entryNarrative }),
  ).toHaveProperty("value", "Starting narrative");
  expect(
    view.getByRole("button", { name: messages.activity.aiRefine }),
  ).toHaveProperty("disabled", false);

  fireEvent.click(
    view.getByRole("button", { name: messages.activity.aiApply }),
  );
  narratives = view.getAllByRole("textbox", {
    name: messages.activity.entryNarrative,
  });
  fireEvent.change(narratives.at(0) ?? panic("Expected kept source work"), {
    target: { value: "Edited kept work" },
  });
  fireEvent.change(narratives.at(1) ?? panic("Expected moved target work"), {
    target: { value: "Edited moved work" },
  });
  fireEvent.click(view.getByRole("button", { name: "Create 2 drafts" }));

  await waitFor(() => expect(boundary.submissions).toHaveLength(1));
  expect(boundary.submissions.at(0)).toMatchObject({
    items: [
      {
        entry: {
          matterId: FIRST_MATTER_ID,
          durationMinutes: 30,
          narrative: "Edited kept work",
        },
      },
      {
        entry: {
          matterId: SECOND_MATTER_ID,
          durationMinutes: 30,
          narrative: "Edited moved work",
        },
      },
    ],
  });
});

test("deferred draft becomes a proposal and undo restores the text edited while it was pending", async () => {
  const boundary = installNativeBoundary();
  const view = mountReview();
  const request = await startDrafting(view, boundary.draftRequests);
  const narrative = view.getByRole("textbox", {
    name: messages.activity.entryNarrative,
  });
  fireEvent.change(narrative, { target: { value: "Typed while waiting" } });
  await resolveDraft(request, review([draft("entry_1", "AI suggestion")]));

  expect(
    view.getByRole("textbox", { name: messages.activity.entryNarrative }),
  ).toHaveProperty("value", "Typed while waiting");
  fireEvent.change(
    view.getByRole("textbox", { name: messages.activity.entryNarrative }),
    { target: { value: "Edited before applying" } },
  );
  fireEvent.click(
    view.getByRole("button", { name: messages.activity.aiAccept }),
  );
  expect(
    view.getByRole("textbox", { name: messages.activity.entryNarrative }),
  ).toHaveProperty("value", "AI suggestion");
  fireEvent.click(
    view.getByRole("button", { name: messages.activity.aiUseOriginal }),
  );
  expect(
    view.getByRole("textbox", { name: messages.activity.entryNarrative }),
  ).toHaveProperty("value", "Edited before applying");
});

test("steering combined drafted subsets above the entry limit asks for a smaller selection without invoking", async () => {
  const firstCandidate = candidates.at(0) ?? panic("Expected a matter");
  const matterCandidates = Array.from(
    { length: DESKTOP_BILLING_DRAFT_LIMITS.entries + 1 },
    (_, index) => ({
      ...firstCandidate,
      id: `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`,
      name: `Matter ${index + 1}`,
    }),
  );
  const boundary = installNativeBoundary(matterCandidates);
  const firstSegment = segments.at(0) ?? panic("Expected activity");
  const view = mountReview(
    snapshot(
      matterCandidates.map(({ id }, index) => ({
        ...firstSegment,
        matterId: id,
        start: Temporal.Instant.from(firstSegment.start)
          .add({ minutes: index * 6 })
          .toString(),
        end: Temporal.Instant.from(firstSegment.start)
          .add({ minutes: (index + 1) * 6 })
          .toString(),
      })),
    ),
  );
  const includeMatter = (name: string) =>
    view.getByRole("checkbox", {
      name: messages.activity.includeMatter.replace("{matter}", () => name),
    });
  await waitFor(() => expect(includeMatter("Matter 1")).toBeTruthy());
  const finalMatter = matterCandidates.at(-1) ?? panic("Expected final matter");
  fireEvent.click(includeMatter(finalMatter.name));
  fireEvent.click(
    view.getByRole("button", { name: messages.activity.aiDraft }),
  );
  await waitFor(() => expect(boundary.draftRequests).toHaveLength(1));
  await resolveDraft(
    firstDraftRequest(boundary.draftRequests),
    review(
      matterCandidates
        .slice(0, DESKTOP_BILLING_DRAFT_LIMITS.entries)
        .map((_, index) => draft(`entry_${index + 1}`, "Drafted work")),
    ),
  );
  for (const matter of matterCandidates.slice(0, -1)) {
    fireEvent.click(includeMatter(matter.name));
  }
  fireEvent.click(includeMatter(finalMatter.name));
  fireEvent.click(
    view.getByRole("button", { name: messages.activity.aiDraft }),
  );
  await waitFor(() => expect(boundary.draftRequests).toHaveLength(2));
  await resolveDraft(
    boundary.draftRequests.at(1) ?? panic("Expected second subset request"),
    review([draft("entry_1", "Last drafted work")]),
  );
  for (const matter of matterCandidates.slice(0, -1)) {
    fireEvent.click(includeMatter(matter.name));
  }
  const input = view.getByPlaceholderText(
    messages.activity.aiSteerAllPlaceholder,
  );
  expect(input).toHaveProperty("disabled", true);
  expect(
    view.getByText(
      messages.activity.aiSteerSelectionLimit.replace("{count}", () =>
        DESKTOP_BILLING_DRAFT_LIMITS.entries.toString(),
      ),
    ),
  ).toBeTruthy();
  expect(
    view.getByRole("button", { name: messages.activity.aiSteerApply }),
  ).toHaveProperty("disabled", true);
  const form = input.closest("form") ?? panic("Expected steering form");
  fireEvent.change(input, { target: { value: "Shorter" } });
  fireEvent.submit(form);
  expect(boundary.draftRequests).toHaveLength(2);
});

for (const change of ["added", "reassigned", "moved-all"] as const) {
  test(`${change} activity invalidates an accepted split before submission`, async () => {
    const boundary = installNativeBoundary();
    const view = mountReview();
    const request = await startDrafting(view, boundary.draftRequests);
    await resolveDraft(
      request,
      review([
        draft("entry_1", "Reviewed work", [
          {
            type: "split",
            parts: [
              {
                durationMinutes: 30,
                narrative: "First half",
                classification: CLIENT_CLASSIFICATION,
                billable: true,
              },
              {
                durationMinutes: 30,
                narrative: "Second half",
                classification: CLIENT_CLASSIFICATION,
                billable: true,
              },
            ],
          },
        ]),
      ]),
    );
    fireEvent.click(
      view.getByRole("button", { name: messages.activity.aiApply }),
    );
    expect(
      view.getAllByRole("textbox", { name: messages.activity.entryNarrative }),
    ).toHaveLength(2);
    const currentSegments = {
      added: [
        ...segments,
        {
          appIdentifier: "com.example.editor",
          appName: "Example Editor",
          matterId: FIRST_MATTER_ID,
          start: "2026-10-07T10:00:00Z",
          end: "2026-10-07T10:06:00Z",
        },
      ],
      "moved-all": segments.map((segment) => ({
        ...segment,
        matterId: SECOND_MATTER_ID,
      })),
      reassigned: [
        {
          appIdentifier: "com.example.editor",
          appName: "Example Editor",
          matterId: FIRST_MATTER_ID,
          start: "2026-10-07T09:00:00Z",
          end: "2026-10-07T09:30:00Z",
        },
        {
          appIdentifier: "com.example.editor",
          appName: "Example Editor",
          matterId: SECOND_MATTER_ID,
          start: "2026-10-07T09:30:00Z",
          end: "2026-10-07T10:00:00Z",
        },
      ],
    }[change];
    view.rerender(
      <DesktopIntlProvider language="en" messages={messages}>
        <ActivityDayReview
          snapshot={snapshot(currentSegments)}
          header={<span>Review</span>}
          billingDrafts={billingDrafts}
          onCopy={(_text, onSettled) => onSettled(true)}
          onReviewStatusChange={() => undefined}
        />
      </DesktopIntlProvider>,
    );
    expect(view.getByText(messages.activity.aiStructureChanged)).toBeTruthy();
    expect(
      view.queryByRole("button", { name: messages.activity.aiUndo }),
    ).toBeNull();
    if (change === "added") {
      fireEvent.click(
        view.getByRole("button", { name: messages.activity.aiDraft }),
      );
      await waitFor(() => expect(boundary.draftRequests).toHaveLength(2));
      await resolveDraft(
        boundary.draftRequests.at(1) ??
          panic("Expected current activity request"),
        review([draft("entry_1", "Updated work")]),
      );
    }
    await act(async () => {
      fireEvent.click(
        view.getByRole("button", {
          name: change === "reassigned" ? "Create 2 drafts" : "Create 1 draft",
        }),
      );
      await Promise.resolve();
    });
    await waitFor(() => expect(boundary.submissions).toHaveLength(1));
    expect(boundary.submissions.at(0)).toMatchObject({
      items:
        change === "added"
          ? [
              {
                entry: { matterId: FIRST_MATTER_ID, durationMinutes: 66 },
                ranges: currentSegments.map(({ start, end }) => ({
                  start,
                  end,
                })),
              },
            ]
          : currentSegments.map(({ matterId, start, end }) => ({
              entry: {
                matterId,
                durationMinutes: change === "moved-all" ? 60 : 30,
              },
              ranges: [{ start, end }],
            })),
    });
    expect(boundary.draftRequests).toHaveLength(change === "added" ? 2 : 1);
  });
}

for (const mode of ["initial", "redraft", "steer"] as const) {
  for (const change of ["ranges", "evidence"] as const) {
    test(`${mode} response after ${change} changes stays a proposal until accepted`, async () => {
      const boundary = installNativeBoundary();
      const firstSegment = segments.at(0) ?? panic("Expected source activity");
      const recorded = {
        ...snapshot(),
        segments: [
          {
            ...firstSegment,
            document: "/work/Before.docx",
            windowTitle: "Earlier note",
          },
        ],
        captureDetails: true,
        detailsAccess: "ready",
      } as const satisfies ActivityDaySnapshot;
      const view = mountReview(recorded);
      await waitFor(() =>
        expect(
          view.getByRole("checkbox", {
            name: messages.activity.includeMatter.replace(
              "{matter}",
              "Source matter",
            ),
          }),
        ).toBeTruthy(),
      );
      fireEvent.click(
        view.getByRole("button", { name: messages.activity.aiDraft }),
      );
      await waitFor(() => expect(boundary.draftRequests).toHaveLength(1));
      let request = firstDraftRequest(boundary.draftRequests);
      expect(request.request).toMatchObject({
        entries: [
          {
            durationMinutes: 60,
            evidence: {
              documentNames: ["Before.docx"],
              windowTitles: ["Earlier note"],
            },
          },
        ],
      });
      if (mode !== "initial") {
        await resolveDraft(
          request,
          review([
            draft("entry_1", "Initial work", [], BASE_LEDGER_CLASSIFICATION),
          ]),
        );
        expect(
          view.getByRole("textbox", { name: messages.activity.entryNarrative }),
        ).toHaveProperty("value", "Initial work");
        if (mode === "redraft") {
          fireEvent.click(
            view.getByRole("button", { name: messages.activity.aiUndoAll }),
          );
          fireEvent.click(
            view.getByRole("button", { name: messages.activity.aiDraft }),
          );
        } else {
          fireEvent.change(
            view.getByPlaceholderText(messages.activity.aiSteerAllPlaceholder),
            { target: { value: "Make the draft shorter" } },
          );
          fireEvent.click(
            view.getByRole("button", { name: messages.activity.aiSteerApply }),
          );
        }
        await waitFor(() => expect(boundary.draftRequests).toHaveLength(2));
        request =
          boundary.draftRequests.at(1) ?? panic("Expected follow-up request");
      }
      const updated = {
        ...recorded,
        segments:
          change === "ranges"
            ? [
                ...recorded.segments,
                {
                  ...firstSegment,
                  start: "2026-10-07T10:00:00Z",
                  end: "2026-10-07T10:06:00Z",
                },
              ]
            : recorded.segments.map((segment) => ({
                ...segment,
                document: "/work/After.docx",
                windowTitle: "Changed note",
              })),
      } satisfies ActivityDaySnapshot;
      view.rerender(
        <DesktopIntlProvider language="en" messages={messages}>
          <ActivityDayReview
            snapshot={updated}
            header={<span>Review</span>}
            billingDrafts={billingDrafts}
            onCopy={(_text, onSettled) => onSettled(true)}
            onReviewStatusChange={() => undefined}
          />
        </DesktopIntlProvider>,
      );
      const narrativeBeforeResponse = view.getByRole("textbox", {
        name: messages.activity.entryNarrative,
      });
      if (!(narrativeBeforeResponse instanceof HTMLTextAreaElement)) {
        panic("Expected review narrative textarea");
      }
      const textBeforeResponse = narrativeBeforeResponse.value;
      const codesBeforeResponse = visibleReviewCodes(view.container);
      expect(textBeforeResponse).not.toBe("Delayed AI suggestion");
      await resolveDraft(
        request,
        review([
          draft(
            "entry_1",
            "Delayed AI suggestion",
            [],
            FIRST_OPERATION_CLASSIFICATION,
          ),
        ]),
      );
      expect(
        view.getByRole("textbox", { name: messages.activity.entryNarrative }),
      ).toHaveProperty("value", textBeforeResponse);
      expect(visibleReviewCodes(view.container)).toEqual(codesBeforeResponse);
      expect(view.getByText(messages.activity.aiStructureChanged)).toBeTruthy();
      fireEvent.click(
        view.getByRole("button", { name: messages.activity.aiAccept }),
      );
      expect(
        view.getByRole("textbox", { name: messages.activity.entryNarrative }),
      ).toHaveProperty("value", "Delayed AI suggestion");
      expect(visibleReviewCodes(view.container)).toEqual([
        ["TASK-101", "ACT-201"],
      ]);
    });
  }
}
