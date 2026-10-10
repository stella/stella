import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import type {
  DesktopBillingDraftClassification,
  DesktopBillingDraftOperation,
  DesktopBillingDraftResponse,
} from "@stll/api-contract/desktop-billing-drafts";

import {
  type BillingDraftValidationContext,
  validateBillingDraftResult,
} from "./billing-drafts-validation";

const fixture = () => {
  const context: BillingDraftValidationContext = {
    entries: ["one", "two"].map((entryId) => ({
      entryId,
      matterId: "matter",
      date: "2026-10-09",
      timezone: "Europe/Prague",
      durationMinutes: 60,
      appNames: ["Editor"],
    })),
    matters: [
      { matterId: "matter", ledesEnabled: false },
      { matterId: "candidate", ledesEnabled: true },
    ],
    earlierEntries: [
      { id: "earlier", matterId: "matter" },
      { id: "other-matter", matterId: "candidate" },
    ],
    guidelines: [
      { fileId: "rules", fileName: "Billing rules", sections: ["Narratives"] },
    ],
  };
  const result: DesktopBillingDraftResponse = {
    drafts: context.entries.map(({ entryId }) => ({
      entryId,
      narrative: "Reviewed agreement",
      classification: { type: "activity_group", activityGroup: "client" },
      flags: [
        {
          text: "Describe the purpose",
          ruleRef: {
            fileId: "rules",
            fileName: "Billing rules",
            section: "Narratives",
          },
        },
      ],
      matchedEarlierEntryIds: ["earlier"],
      operations: [],
    })),
    checkedGuidelines: [{ fileId: "rules", fileName: "Billing rules" }],
  };
  return { context, result };
};

const draftAt = (result: DesktopBillingDraftResponse, index: number) => {
  const draft = result.drafts.at(index);
  if (!draft) {
    return panic("Missing fixture draft");
  }
  return draft;
};

const split = (durations: number[]): DesktopBillingDraftOperation => ({
  type: "split",
  parts: durations.map((durationMinutes) => ({
    durationMinutes,
    narrative: "Reviewed agreement",
    classification: { type: "activity_group", activityGroup: "client" },
    billable: true,
  })),
});

describe("Billing draft authorization and operation invariants", () => {
  test("accepts contextual references and an exactly conserved split", () => {
    const { context, result } = fixture();
    for (const first of [1, 17, 30, 59]) {
      draftAt(result, 0).operations = [split([first, 60 - first])];
      expect(validateBillingDraftResult(result, context).isOk()).toBe(true);
    }
  });

  test("refuses all split duration deviations from the original", () => {
    const { context, result } = fixture();
    for (const delta of [-2, -1, 1, 2]) {
      draftAt(result, 0).operations = [split([30, 30 + delta])];
      expect(validateBillingDraftResult(result, context).isErr()).toBe(true);
    }
  });

  test("requires exact selected entry coverage without duplicate identifiers", () => {
    for (const ids of [["one"], ["one", "one"], ["one", "unselected"]]) {
      const { context, result } = fixture();
      const draft = draftAt(result, 0);
      result.drafts = ids.map((entryId) => ({ ...draft, entryId }));
      expect(validateBillingDraftResult(result, context).isErr()).toBe(true);
    }
  });

  test("refuses earlier entries outside authorized caller matter context", () => {
    for (const id of ["unselected-history", "other-matter"]) {
      const { context, result } = fixture();
      draftAt(result, 0).matchedEarlierEntryIds = [id];
      expect(validateBillingDraftResult(result, context).isErr()).toBe(true);
    }
  });

  test("requires file identity, section and client applicability for every rule citation", () => {
    for (const ruleRef of [
      { fileId: "unknown", fileName: "Billing rules", section: "Narratives" },
      { fileId: "rules", fileName: "Invented name", section: "Narratives" },
      {
        fileId: "rules",
        fileName: "Billing rules",
        section: "Invented section",
      },
    ]) {
      const { context, result } = fixture();
      draftAt(result, 0).flags = [{ text: "Flag", ruleRef }];
      expect(validateBillingDraftResult(result, context).isErr()).toBe(true);
    }
    const { context, result } = fixture();
    context.guidelines = [
      {
        fileId: "rules",
        fileName: "Billing rules",
        sections: ["Narratives"],
        matterIds: ["candidate"],
      },
    ];
    expect(validateBillingDraftResult(result, context).isErr()).toBe(true);
  });

  test("checked guideline files cannot be forged, omitted or duplicated", () => {
    for (const ids of [[], ["unknown"], ["rules", "rules"]]) {
      const { context, result } = fixture();
      result.checkedGuidelines = ids.map((fileId) => ({
        fileId,
        fileName: "Billing rules",
      }));
      expect(validateBillingDraftResult(result, context).isErr()).toBe(true);
    }
  });

  test("codes are permitted only for LEDES matters, including split and change proposals", () => {
    const { context, result } = fixture();
    const ledes = {
      type: "ledes",
      taskCode: "L110",
      activityCode: "A101",
    } as const;
    draftAt(result, 0).classification = ledes;
    expect(validateBillingDraftResult(result, context).isErr()).toBe(true);
    draftAt(result, 0).classification = {
      type: "activity_group",
      activityGroup: "client",
    };
    draftAt(result, 0).operations = [
      { type: "change_classification", classification: ledes },
    ];
    expect(validateBillingDraftResult(result, context).isErr()).toBe(true);
    draftAt(result, 0).operations = [
      {
        type: "split",
        parts: [30, 30].map((durationMinutes) => ({
          durationMinutes,
          narrative: "Review",
          classification: ledes,
          billable: true,
        })),
      },
    ];
    expect(validateBillingDraftResult(result, context).isErr()).toBe(true);
    context.matters = [{ matterId: "matter", ledesEnabled: true }];
    for (const draft of result.drafts) {
      draft.classification = ledes;
    }
    expect(validateBillingDraftResult(result, context).isOk()).toBe(true);
  });

  test("merge requires selected sources sharing matter and date", () => {
    const merge: DesktopBillingDraftOperation = {
      type: "merge",
      entryIds: ["one", "two"],
      narrative: "Combined review",
      classification: { type: "activity_group", activityGroup: "client" },
      billable: true,
    };
    const valid = fixture();
    draftAt(valid.result, 0).operations = [merge];
    expect(validateBillingDraftResult(valid.result, valid.context).isOk()).toBe(
      true,
    );
    for (const variation of [
      "matter",
      "date",
      "unselected",
      "duplicate",
      "owner",
    ] as const) {
      const { context, result } = fixture();
      draftAt(result, 0).operations = [merge];
      switch (variation) {
        case "matter":
          context.entries = context.entries.map((entry) =>
            entry.entryId === "two"
              ? { ...entry, matterId: "candidate" }
              : entry,
          );
          context.matters = context.matters.map((matter) => ({
            ...matter,
            ledesEnabled: false,
          }));
          break;
        case "date":
          context.entries = context.entries.map((entry) =>
            entry.entryId === "two" ? { ...entry, date: "2026-10-08" } : entry,
          );
          break;
        case "unselected":
          draftAt(result, 0).operations = [
            { ...merge, entryIds: ["one", "unknown"] },
          ];
          break;
        case "duplicate":
          draftAt(result, 0).operations = [
            { ...merge, entryIds: ["one", "one"] },
          ];
          break;
        case "owner":
          draftAt(result, 0).operations = [
            { ...merge, entryIds: ["two", "unknown"] },
          ];
          break;
        default:
          panic("Unknown fixture variation", variation satisfies never);
      }
      expect(validateBillingDraftResult(result, context).isErr()).toBe(true);
    }
  });

  test("consumed merge sources cannot carry other operations in either draft order", () => {
    const { context, result } = fixture();
    draftAt(result, 0).operations = [
      {
        type: "merge",
        entryIds: ["one", "two"],
        narrative: "Review",
        classification: { type: "activity_group", activityGroup: "client" },
        billable: true,
      },
    ];
    draftAt(result, 1).operations = [{ type: "set_billable", billable: false }];
    expect(validateBillingDraftResult(result, context).isErr()).toBe(true);
    result.drafts.reverse();
    expect(validateBillingDraftResult(result, context).isErr()).toBe(true);
  });

  test("move requires a different authorized matter and bounded time", () => {
    for (const [targetMatterId, durationMinutes, accepted] of [
      ["candidate", 60, true],
      ["candidate", 61, false],
      ["unknown", 30, false],
      ["matter", 30, false],
    ] as const) {
      const { context, result } = fixture();
      draftAt(result, 0).operations = [
        {
          type: "move",
          targetMatterId,
          durationMinutes,
          narrative: "Review",
          classification: {
            type: "ledes",
            taskCode: "L110",
            activityCode: "A101",
          },
          billable: true,
        },
      ];
      expect(validateBillingDraftResult(result, context).isOk()).toBe(accepted);
    }
  });

  test("structural and duplicate proposals cannot overlap", () => {
    const { context, result } = fixture();
    draftAt(result, 0).operations = [
      split([30, 30]),
      {
        type: "move",
        targetMatterId: "candidate",
        durationMinutes: 30,
        narrative: "Review",
        classification: {
          type: "ledes",
          taskCode: "L110",
          activityCode: "A101",
        },
        billable: true,
      },
    ];
    expect(validateBillingDraftResult(result, context).isErr()).toBe(true);
    draftAt(result, 0).operations = [
      { type: "set_billable", billable: true },
      { type: "set_billable", billable: false },
    ];
    expect(validateBillingDraftResult(result, context).isErr()).toBe(true);
  });
});

test("moves use the destination matter's billing classification", () => {
  const { context, result } = fixture();
  draftAt(result, 0).operations = [
    {
      type: "move",
      targetMatterId: "candidate",
      durationMinutes: 30,
      narrative: "Review",
      classification: { type: "activity_group", activityGroup: "client" },
      billable: true,
    },
  ];
  expect(validateBillingDraftResult(result, context).isErr()).toBe(true);
});

test("split guideline fixes include an executable split proposal rather than an unrelated operation", () => {
  const merge: DesktopBillingDraftOperation = {
    type: "merge",
    entryIds: ["one", "two"],
    narrative: "Combined review",
    classification: { type: "activity_group", activityGroup: "client" },
    billable: true,
  };
  const move: DesktopBillingDraftOperation = {
    type: "move",
    targetMatterId: "candidate",
    durationMinutes: 30,
    narrative: "Review",
    classification: { type: "ledes", taskCode: "L110", activityCode: "A101" },
    billable: true,
  };
  for (const { operations, accepted } of [
    { operations: [], accepted: false },
    { operations: [merge], accepted: false },
    { operations: [move], accepted: false },
    { operations: [split([30, 30])], accepted: true },
  ]) {
    const { context, result } = fixture();
    const draft = draftAt(result, 0);
    draft.flags = [
      {
        text: "Separate activities",
        ruleRef: {
          fileId: "rules",
          fileName: "Billing rules",
          section: "Narratives",
        },
        fix: "split",
      },
    ];
    draft.operations = operations;
    expect(validateBillingDraftResult(result, context).isOk()).toBe(accepted);
  }
});

test("matter-backed drafts reject internal categories in every classification-bearing proposal", () => {
  const internal = {
    type: "activity_group",
    activityGroup: "internal",
  } as const;
  const client = { type: "activity_group", activityGroup: "client" } as const;
  for (const proposal of [
    { classification: internal, operations: [] },
    {
      classification: client,
      operations: [{ type: "change_classification", classification: internal }],
    },
    {
      classification: client,
      operations: [
        {
          type: "split",
          parts: [30, 30].map((durationMinutes) => ({
            durationMinutes,
            narrative: "Review",
            classification: internal,
            billable: false,
          })),
        },
      ],
    },
    {
      classification: client,
      operations: [
        {
          type: "merge",
          entryIds: ["one", "two"],
          narrative: "Review",
          classification: internal,
          billable: false,
        },
      ],
    },
    {
      classification: client,
      operations: [
        {
          type: "move",
          targetMatterId: "candidate",
          durationMinutes: 30,
          narrative: "Review",
          classification: internal,
          billable: false,
        },
      ],
    },
  ] satisfies {
    classification: DesktopBillingDraftClassification;
    operations: DesktopBillingDraftOperation[];
  }[]) {
    const { context, result } = fixture();
    context.matters = context.matters.map((matter) => ({
      ...matter,
      ledesEnabled: false,
    }));
    draftAt(result, 0).classification = proposal.classification;
    draftAt(result, 0).operations = proposal.operations;
    expect(validateBillingDraftResult(result, context).isErr()).toBe(true);
  }
});

test("structural proposals stand alone regardless of scalar operation kind or order", () => {
  const structuralOperations = [
    split([30, 30]),
    {
      type: "merge",
      entryIds: ["one", "two"],
      narrative: "Combined review",
      classification: { type: "activity_group", activityGroup: "client" },
      billable: true,
    },
    {
      type: "move",
      targetMatterId: "candidate",
      durationMinutes: 30,
      narrative: "Review",
      classification: { type: "ledes", taskCode: "L110", activityCode: "A101" },
      billable: true,
    },
  ] satisfies DesktopBillingDraftOperation[];
  const scalarOperations = [
    { type: "rewrite", narrative: "Revised narrative" },
    {
      type: "change_classification",
      classification: { type: "activity_group", activityGroup: "client" },
    },
    { type: "set_billable", billable: false },
  ] satisfies DesktopBillingDraftOperation[];
  for (const structural of structuralOperations) {
    for (const scalar of scalarOperations) {
      const { context, result } = fixture();
      const draft = draftAt(result, 0);
      draft.operations = [structural];
      expect(validateBillingDraftResult(result, context).isOk()).toBe(true);
      draft.operations = [scalar];
      expect(validateBillingDraftResult(result, context).isOk()).toBe(true);
      for (const operations of [
        [structural, scalar],
        [scalar, structural],
      ]) {
        draft.operations = operations;
        expect(validateBillingDraftResult(result, context).isErr()).toBe(true);
      }
    }
  }
});
