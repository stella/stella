import { describe, expect, test } from "bun:test";

import { SUGGESTION_KIND } from "@stll/api-contract/signals";
import { WORK_TYPES } from "@/components/workspaces/tasks/task-detail-constants";
import type { ConditionNode } from "@stll/conditions";

import { toSafeId } from "@/lib/safe-id";

import { proposalMatchesFilters } from "./model";
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
    evidence: { kind: "request.submitted", description: "Review", attachments: [] },
    suggestions: [{ kind: "create-task", workspaceId: "matter-1", name: "Review", dueAt: null }],
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
        expect(proposalMatchesFilters(proposal, [{
          type: "group", combinator, negated, children: [incompleteFilter],
        }])).toBe(true);
        expect(proposalMatchesFilters(proposal, [{
          type: "group", combinator, negated, children: [taskFilter, incompleteFilter],
        }])).toBe(!negated);
      }
    }
  });

  test("unsupported leaves are dropped instead of widening OR groups", () => {
    const nonmatching = { ...taskFilter, value: ["document"] };
    expect(proposalMatchesFilters(proposal, [{
      type: "group",
      combinator: "or",
      negated: false,
      children: [nonmatching, {
        type: "predicate",
        operand: { type: "kind" },
        op: "is_not_empty",
      }],
    }])).toBe(false);
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
            suggestions: [{
              kind: actualType === "deadline"
                ? SUGGESTION_KIND.CREATE_DEADLINE
                : SUGGESTION_KIND.CREATE_TASK,
              workspaceId: proposal.signal.workspaceId,
              name: "Review deadline",
              dueAt: "2027-03-31",
            }],
          },
        } satisfies EntityViewEntry;
        expect(proposalMatchesFilters(entry, [taskFilter, {
          type: "predicate",
          operand: { type: "builtin", field: "agendaKind" },
          op: "in",
          value: [selectedType],
        }])).toBe(actualType === selectedType);
      });
    }
  }
});
