import { describe, expect, test } from "bun:test";

import { SUGGESTION_KIND } from "@stll/api-contract/signals";
import type { ConditionNode } from "@stll/conditions";

import { WORK_TYPES } from "@/components/workspaces/tasks/task-detail-constants";
import { toSafeId } from "@/lib/safe-id";

import { proposalMatchesFilters, sortEntityViewEntries } from "./model";
import type { EntityViewEntry } from "./types";

const proposal = {
  type: "proposal",
  signal: {
    id: toSafeId<"signal">("signal-1"),
    workspaceId: toSafeId<"workspace">("matter-1"),
    workspaceName: "Matter",
    kind: "request.submitted",
    origin: "manual",
    scoutKey: "manual",
    severity: "info",
    confidence: null,
    title: "Request",
    summary: "Review request",
    subject: { type: "workspace", workspaceId: "matter-1" },
    evidence: {
      kind: "request.submitted",
      description: "Review",
      attachments: [],
    },
    suggestions: [
      {
        kind: "create-task",
        workspaceId: "matter-1",
        name: "Review",
        dueAt: null,
      },
    ],
    status: "new",
    snoozedUntil: null,
    assigneeUserId: null,
    assigneeUserName: null,
    assigneeUserImage: null,
    createdByUserId: null,
    dismissReason: null,
    acceptedResult: null,
    resolvedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
} satisfies EntityViewEntry;

const taskFilter = {
  type: "predicate",
  operand: { type: "kind" },
  op: "in",
  value: ["task"],
} satisfies ConditionNode;

const incompleteFilter = {
  type: "predicate",
  operand: { type: "builtin", field: "status" },
  op: "in",
  value: [],
} satisfies ConditionNode;

describe("proposal filters follow canonical condition pruning", () => {
  test("draft filters impose no restriction, including empty negated groups", () => {
    for (const combinator of ["and", "or"] as const) {
      for (const negated of [false, true]) {
        expect(
          proposalMatchesFilters(proposal, [
            {
              type: "group",
              combinator,
              negated,
              children: [incompleteFilter],
            },
          ]),
        ).toBe(true);
        expect(
          proposalMatchesFilters(proposal, [
            {
              type: "group",
              combinator,
              negated,
              children: [taskFilter, incompleteFilter],
            },
          ]),
        ).toBe(!negated);
      }
    }
  });

  test("unsupported leaves are dropped instead of widening OR groups", () => {
    const nonmatching = { ...taskFilter, value: ["document"] };
    expect(
      proposalMatchesFilters(proposal, [
        {
          type: "group",
          combinator: "or",
          negated: false,
          children: [
            nonmatching,
            {
              type: "predicate",
              operand: { type: "kind" },
              op: "is_not_empty",
            },
          ],
        },
      ]),
    ).toBe(false);
  });
});

describe("proposal type filters agree with the proposed work type", () => {
  for (const actualType of WORK_TYPES) {
    for (const selectedType of WORK_TYPES) {
      test(`${actualType} matches only ${actualType}, selected ${selectedType}`, () => {
        const entry = {
          ...proposal,
          signal: {
            ...proposal.signal,
            suggestions: [
              {
                kind:
                  actualType === "deadline"
                    ? SUGGESTION_KIND.CREATE_DEADLINE
                    : SUGGESTION_KIND.CREATE_TASK,
                workspaceId: proposal.signal.workspaceId,
                name: "Review deadline",
                dueAt: "2027-03-31",
              },
            ],
          },
        } satisfies EntityViewEntry;
        expect(
          proposalMatchesFilters(entry, [
            taskFilter,
            {
              type: "predicate",
              operand: { type: "builtin", field: "agendaKind" },
              op: "in",
              value: [selectedType],
            },
          ]),
        ).toBe(actualType === selectedType);
      });
    }
  }
});

const storedTask = {
  type: "entity",
  workspaceId: "matter-1",
  workspaceName: "Matter",
  entity: {
    entityId: toSafeId<"entity">("task-1"),
    kind: "task",
    name: "A task",
    parentId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: null,
    createdByUserId: null,
    createdByImage: null,
    createdByDeletedAt: null,
    updatedAt: null,
    version: 1,
    currentVersionReference: null,
    status: "done",
    priority: "high",
    listItemType: "task",
    dueDate: "2027-01-01",
    agendaKind: "task",
    startAt: null,
    endAt: null,
    occurredAt: null,
    remindAt: null,
    allDay: false,
    timeZone: null,
    location: null,
    onlineMeetingUrl: null,
    availability: null,
    sensitivity: null,
    organizer: null,
    attendees: null,
    recurrence: null,
    agendaSource: "manual",
    externalSource: null,
    externalId: null,
    externalChangeKey: null,
    externalICalUid: null,
    readOnly: false,
    sortOrder: null,
    activeEditBy: null,
    fields: {},
    cellMetadata: {},
    assignees: [],
  },
} satisfies EntityViewEntry;

describe("mixed proposals and stored items share the selected sort", () => {
  const datedProposal = {
    ...proposal,
    signal: {
      ...proposal.signal,
      suggestions: [
        {
          kind: SUGGESTION_KIND.CREATE_TASK,
          workspaceId: "matter-1",
          name: "Review",
          dueAt: "2027-02-01",
        },
      ],
    },
  } satisfies EntityViewEntry;

  for (const propertyId of ["_name", "_status", "_due-date"]) {
    for (const desc of [false, true]) {
      test(`${propertyId} ${desc ? "descending" : "ascending"} interleaves both sources`, () => {
        const result = sortEntityViewEntries({
          entries: [datedProposal, storedTask],
          sorts: [{ propertyId, desc }],
          locale: "en",
        });
        expect(result).toEqual(
          desc ? [datedProposal, storedTask] : [storedTask, datedProposal],
        );
      });
    }
  }

  test("missing values stay last in either direction", () => {
    for (const desc of [false, true]) {
      expect(
        sortEntityViewEntries({
          entries: [proposal, storedTask],
          sorts: [{ propertyId: "_priority", desc }],
          locale: "en",
        }),
      ).toEqual([storedTask, proposal]);
    }
  });

  test("no sort preserves the proposal-first source order", () => {
    expect(
      sortEntityViewEntries({
        entries: [proposal, storedTask],
        sorts: [],
        locale: "en",
      }),
    ).toEqual([proposal, storedTask]);
  });
});
