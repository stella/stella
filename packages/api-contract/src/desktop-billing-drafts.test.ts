import { toJsonSchema } from "@valibot/to-json-schema";
import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import type { GenericSchema } from "valibot";
import * as v from "valibot";

import { API_DATE_RUNTIME_ONLY_CHECKS } from "./api-date";
import {
  DESKTOP_BILLING_DRAFT_LIMITS,
  desktopBillingDraftEntrySchema,
  desktopBillingDraftEvidenceSchema,
  desktopBillingDraftModelResponseSchema,
  type DesktopBillingDraftOperation,
  desktopBillingDraftOperationSchema,
  type DesktopBillingDraftRequest,
  desktopBillingDraftRequestSchema,
  desktopBillingDraftResponseSchema,
  desktopBillingDraftReviewSchema,
  type DesktopBillingDraftSettingsRequest,
  desktopBillingDraftSettingsRequestSchema,
  desktopBillingDraftSettingsResponseSchema,
  type DesktopBillingGuidedDraftResponse,
  desktopBillingGuidedDraftResponseSchema,
  desktopBillingPlainDraftModelResponseSchema,
  type DesktopBillingPlainDraftResponse,
  desktopBillingPlainDraftResponseSchema,
} from "./desktop-billing-drafts";
import { keepUnicodePatternSource } from "./json-schema-regex";
import { UUID_RUNTIME_ONLY_ACTIONS } from "./uuid";

const entry = {
  entryId: "entry_1",
  matterId: "12345678-1234-4123-8123-123456789abc",
  date: "2026-10-09",
  timezone: "Europe/Prague",
  durationMinutes: 30,
  appNames: ["Editor"],
  evidence: { documentNames: ["Agreement.docx"], windowTitles: ["Review"] },
} satisfies DesktopBillingDraftRequest["entries"][number];

const response = {
  mode: "guided",
  drafts: [
    {
      entryId: "entry_1",
      narrative: "Reviewed agreement",
      classification: { type: "activity_group", activityGroup: "client" },
      flags: [
        {
          text: "Separate independent activities",
          ruleRef: {
            fileId: "firm-rules",
            fileName: "Billing guidelines",
            section: "Block billing",
          },
          fix: "split",
        },
      ],
      matchedEarlierEntryIds: ["earlier-entry"],
      operations: [],
    },
  ],
  checkedGuidelines: [{ fileId: "firm-rules", fileName: "Billing guidelines" }],
} satisfies DesktopBillingGuidedDraftResponse;

const plainResponse = {
  mode: "plain",
  drafts: [
    {
      entryId: "entry_1",
      narrative: "Reviewed agreement",
      matchedEarlierEntryIds: ["earlier-entry"],
    },
  ],
} satisfies DesktopBillingPlainDraftResponse;

/** The model answers without a mode; the server names it. */
const modelShape = <TResponse extends { mode: string }>({
  mode: _mode,
  ...shape
}: TResponse) => shape;

const RUNTIME_ONLY_ACTIONS: ReadonlySet<unknown> = new Set([
  ...API_DATE_RUNTIME_ONLY_CHECKS,
  ...UUID_RUNTIME_ONLY_ACTIONS,
]);

const toBillingDraftJsonSchema = (schema: GenericSchema) =>
  toJsonSchema(schema, {
    overrideAction: (context) =>
      keepUnicodePatternSource(context) ??
      (RUNTIME_ONLY_ACTIONS.has(context.valibotAction)
        ? context.jsonSchema
        : undefined),
  });

test("billing draft request keys remain limited to selected evidence and steering", () => {
  expect(
    Object.keys(desktopBillingDraftRequestSchema.pipe[0].entries).toSorted(),
  ).toEqual(["entries", "previousResult", "steer"]);
  expect(
    Object.keys(desktopBillingDraftEntrySchema.entries).toSorted(),
  ).toEqual([
    "appNames",
    "date",
    "durationMinutes",
    "entryId",
    "evidence",
    "matterId",
    "timezone",
  ]);
  expect(
    Object.keys(desktopBillingDraftEvidenceSchema.entries).toSorted(),
  ).toEqual(["documentNames", "windowTitles"]);
  expect(
    toJsonSchema(desktopBillingDraftRequestSchema, { errorMode: "ignore" }),
  ).toMatchObject({ additionalProperties: false });

  for (const field of [
    "timeline",
    "screenContents",
    "clipboard",
    "excludedApps",
    "unselectedTime",
    "userId",
    "organizationId",
    "candidateMatterIds",
    "windowTitles",
    "narrative",
  ]) {
    expect(
      v.safeParse(desktopBillingDraftRequestSchema, {
        entries: [entry],
        [field]: "private",
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(desktopBillingDraftRequestSchema, {
        entries: [{ ...entry, [field]: "private" }],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(desktopBillingDraftRequestSchema, {
        entries: [
          { ...entry, evidence: { ...entry.evidence, [field]: "private" } },
        ],
      }).success,
    ).toBe(false);
  }
});

test("billing draft responses emit finite direct JSON schemas for native response validation", () => {
  const unsupportedKeywords = ["$ref", "allOf", "oneOf", "not"];
  for (const schema of [
    desktopBillingGuidedDraftResponseSchema,
    desktopBillingPlainDraftResponseSchema,
    desktopBillingDraftModelResponseSchema,
    desktopBillingPlainDraftModelResponseSchema,
    desktopBillingDraftSettingsResponseSchema,
  ]) {
    const jsonSchema = toBillingDraftJsonSchema(schema);
    const serialized = JSON.stringify(jsonSchema);
    for (const unsupported of unsupportedKeywords) {
      expect(serialized).not.toContain(`"${unsupported}":`);
    }
    expect(jsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
  }
  const union = toBillingDraftJsonSchema(desktopBillingDraftResponseSchema);
  for (const unsupported of unsupportedKeywords) {
    expect(JSON.stringify(union)).not.toContain(`"${unsupported}":`);
  }
  expect(union).toMatchObject({
    anyOf: [
      { type: "object", additionalProperties: false },
      { type: "object", additionalProperties: false },
    ],
  });
});

test("billing drafting settings accept only personal consent and bounded preferences", () => {
  const revision = "2026-10-30 13:03:04.123456+01";
  for (const patch of [
    { type: "withdraw_consent" },
    { type: "grant_consent", revision: null },
    { type: "grant_consent", revision },
    {
      type: "set_preference",
      revision,
      preference: "Use concise Czech narratives",
    },
    { type: "set_preference", revision: null, preference: null },
  ] satisfies DesktopBillingDraftSettingsRequest[]) {
    expect(v.parse(desktopBillingDraftSettingsRequestSchema, patch)).toEqual(
      patch,
    );
  }
  for (const patch of [
    {},
    { consent: "granted" },
    { consent: "revoked" },
    { type: "pending" },
    { type: "grant_consent" },
    { type: "grant_consent", revision: "" },
    { type: "grant_consent", revision, organizationMode: "enabled" },
    { type: "grant_consent", revision, userId: "another-user" },
    { type: "grant_consent", revision, preference: "Combined" },
    { type: "set_preference", revision, preference: "" },
    { type: "set_preference", preference: "Missing revision" },
    {
      type: "set_preference",
      revision,
      preference: "x".repeat(DESKTOP_BILLING_DRAFT_LIMITS.steerLength + 1),
    },
    { type: "set_preference", revision, preference: "text\u0000text" },
  ]) {
    expect(
      v.safeParse(desktopBillingDraftSettingsRequestSchema, patch).success,
    ).toBe(false);
  }
  for (const effectiveMode of ["off", "plain", "guided"] as const) {
    for (const consent of ["granted", "revoked"] as const) {
      for (const stored of [null, revision]) {
        const settings = {
          revision: stored,
          effectiveMode,
          consent,
          preference: null,
        };
        expect(
          v.parse(desktopBillingDraftSettingsResponseSchema, settings),
        ).toEqual(settings);
      }
    }
  }
  // The organization's raw switch is not part of the answer: the effective
  // mode already says whether anything is drafted.
  for (const settings of [
    {
      revision,
      organizationMode: "enabled",
      consent: "granted",
      preference: null,
    },
    {
      revision,
      effectiveMode: "enabled",
      consent: "granted",
      preference: null,
    },
  ]) {
    expect(
      v.safeParse(desktopBillingDraftSettingsResponseSchema, settings).success,
    ).toBe(false);
  }
});

test("a consent withdrawal cannot be made conditional on a revision", () => {
  for (const revision of [null, "2026-10-30 13:03:04.123456+01"]) {
    expect(
      v.safeParse(desktopBillingDraftSettingsRequestSchema, {
        type: "withdraw_consent",
        revision,
      }).success,
    ).toBe(false);
  }
  expect(
    v.safeParse(desktopBillingDraftSettingsRequestSchema, {
      type: "withdraw_consent",
    }).success,
  ).toBe(true);
});

test("a plain description result has no classification, guideline flag or operation fields", () => {
  expect(v.parse(desktopBillingDraftResponseSchema, plainResponse)).toEqual(
    plainResponse,
  );
  const draft = plainResponse.drafts.at(0);
  assert.ok(draft);
  for (const guidedField of [
    { classification: { type: "activity_group", activityGroup: "client" } },
    {
      classification: { type: "ledes", taskCode: "L120", activityCode: "A104" },
    },
    { flags: [] },
    { operations: [] },
  ]) {
    const value = { ...plainResponse, drafts: [{ ...draft, ...guidedField }] };
    expect(v.safeParse(desktopBillingDraftResponseSchema, value).success).toBe(
      false,
    );
    expect(
      v.safeParse(
        desktopBillingPlainDraftModelResponseSchema,
        modelShape(value),
      ).success,
    ).toBe(false);
  }
  for (const invalid of [
    { ...plainResponse, checkedGuidelines: [] },
    { ...response, mode: "plain" },
    modelShape(response),
    modelShape(plainResponse),
  ]) {
    expect(
      v.safeParse(desktopBillingDraftResponseSchema, invalid).success,
    ).toBe(false);
  }
  expect(
    v.parse(
      desktopBillingPlainDraftModelResponseSchema,
      modelShape(plainResponse),
    ),
  ).toEqual(modelShape(plainResponse));
  const request = {
    entries: [entry],
    steer: "Shorter",
    previousResult: plainResponse,
  };
  expect(v.parse(desktopBillingDraftRequestSchema, request)).toEqual(request);
});

test("steering round trips the bounded structured result without server session state", () => {
  const request = {
    entries: [entry],
    steer: "Write in Czech",
    previousResult: response,
  };
  expect(v.parse(desktopBillingDraftRequestSchema, request)).toEqual(request);
  expect(v.parse(desktopBillingDraftResponseSchema, response)).toEqual(
    response,
  );
  for (const steer of [
    "",
    "x".repeat(DESKTOP_BILLING_DRAFT_LIMITS.steerLength + 1),
    "secret\u0000text",
  ]) {
    expect(
      v.safeParse(desktopBillingDraftRequestSchema, { ...request, steer })
        .success,
    ).toBe(false);
  }
  expect(
    v.safeParse(desktopBillingDraftRequestSchema, {
      ...request,
      previousResult: { ...response, transcript: "private" },
    }).success,
  ).toBe(false);
  expect(
    v.safeParse(desktopBillingDraftRequestSchema, {
      entries: [entry],
      previousResult: response,
    }).success,
  ).toBe(false);
});

test("selected entry inputs and guideline citations have finite validated bounds", () => {
  for (const invalid of [
    { durationMinutes: 0 },
    { durationMinutes: 1.5 },
    { durationMinutes: 1441 },
    { appNames: ["x".repeat(DESKTOP_BILLING_DRAFT_LIMITS.nameLength + 1)] },
    { date: "09/10/2026" },
    { matterId: "malformed" },
    {
      evidence: {
        documentNames: [],
        windowTitles: Array.from(
          { length: DESKTOP_BILLING_DRAFT_LIMITS.evidenceItems + 1 },
          () => "Subject",
        ),
      },
    },
  ]) {
    expect(
      v.safeParse(desktopBillingDraftRequestSchema, {
        entries: [{ ...entry, ...invalid }],
      }).success,
    ).toBe(false);
  }
  expect(
    v.safeParse(desktopBillingDraftRequestSchema, { entries: [] }).success,
  ).toBe(false);
  expect(
    v.safeParse(desktopBillingDraftRequestSchema, {
      entries: Array.from(
        { length: DESKTOP_BILLING_DRAFT_LIMITS.entries + 1 },
        () => entry,
      ),
    }).success,
  ).toBe(false);
  for (const flags of [
    [{ text: "Uncited flag" }],
    [
      {
        text: "Incomplete citation",
        ruleRef: { fileId: "rules", fileName: "Rules" },
      },
    ],
  ]) {
    expect(
      v.safeParse(desktopBillingDraftResponseSchema, {
        ...response,
        drafts: response.drafts.map((draft) => ({ ...draft, flags })),
      }).success,
    ).toBe(false);
  }
});

test("billing matter UUIDs normalize casing at the contract boundary", () => {
  const uppercase = "12345678-1234-4123-8123-123456789ABC";
  const parsedRequest = v.parse(desktopBillingDraftRequestSchema, {
    entries: [{ ...entry, matterId: uppercase }],
  });
  expect(parsedRequest.entries.at(0)?.matterId).toBe(entry.matterId);

  const moved = {
    ...response,
    drafts: response.drafts.map((draft) => ({
      ...draft,
      operations: [
        {
          type: "move" as const,
          targetMatterId: uppercase,
          targetMatterName: "Candidate matter",
          durationMinutes: 15,
          narrative: "Reviewed terms",
          classification: {
            type: "activity_group" as const,
            activityGroup: "client" as const,
          },
          billable: true,
        },
      ],
    })),
  };
  expect(
    v
      .parse(desktopBillingGuidedDraftResponseSchema, moved)
      .drafts.at(0)
      ?.operations.at(0),
  ).toMatchObject({ targetMatterId: entry.matterId });

  const { previousResult } = v.parse(desktopBillingDraftRequestSchema, {
    entries: [entry],
    steer: "Keep the same proposal",
    previousResult: moved,
  });
  assert.ok(previousResult?.mode === "guided");
  expect(previousResult.drafts.at(0)?.operations.at(0)).toMatchObject({
    targetMatterId: entry.matterId,
  });
});

test("billing draft request and review dates are real calendar days in CE years", () => {
  for (const date of ["2026-02-30", "0000-01-01"]) {
    expect(
      v.safeParse(desktopBillingDraftRequestSchema, {
        entries: [{ ...entry, date }],
      }).success,
    ).toBe(false);

    expect(
      v.safeParse(desktopBillingDraftReviewSchema, {
        result: response,
        earlierEntries: [
          {
            id: "earlier-entry",
            dateWorked: date,
            durationMinutes: 30,
            narrative: "Reviewed agreement",
          },
        ],
      }).success,
    ).toBe(false);
  }
});

test("draft operations carry reviewable payloads and classification branches remain exclusive", () => {
  const classification = {
    type: "activity_group",
    activityGroup: "client",
  } as const;
  const part = {
    durationMinutes: 15,
    narrative: "Reviewed terms",
    classification,
    billable: true,
  };
  for (const operation of [
    { type: "rewrite", narrative: "Revised narrative" },
    {
      type: "change_classification",
      classification: { type: "ledes", taskCode: "L120", activityCode: "A104" },
    },
    { type: "set_billable", billable: false },
    { type: "split", parts: [part, part] },
    {
      type: "merge",
      entryIds: ["first", "second"],
      narrative: "Combined work",
      classification,
      billable: true,
    },
    {
      type: "move",
      targetMatterId: "12345678-1234-4123-8123-123456789abd",
      targetMatterName: "Candidate matter",
      durationMinutes: 15,
      narrative: "Reviewed terms for target matter",
      classification,
      billable: true,
    },
  ] satisfies DesktopBillingDraftOperation[]) {
    expect(v.parse(desktopBillingDraftOperationSchema, operation)).toEqual(
      operation,
    );
    const value = {
      ...response,
      drafts: response.drafts.map((draft) => ({
        ...draft,
        operations: [operation],
      })),
    };
    expect(v.parse(desktopBillingDraftResponseSchema, value)).toEqual(value);
    expect(
      v.parse(desktopBillingDraftModelResponseSchema, modelShape(value)),
    ).toEqual(modelShape(value));
  }
  for (const operation of [
    { type: "split", parts: [part] },
    { type: "move", targetMatterId: "12345678-1234-4123-8123-123456789abd" },
    { type: "move", targetMatterId: "malformed", durationMinutes: 15 },
    {
      type: "merge",
      entryIds: ["first"],
      narrative: "Combined work",
      classification,
      billable: true,
    },
    {
      type: "change_classification",
      classification: { ...classification, taskCode: "L120" },
    },
    { type: "execute", command: "create entries" },
  ]) {
    expect(
      v.safeParse(desktopBillingDraftOperationSchema, operation).success,
    ).toBe(false);
  }
});

test("draft guideline counts and billing codes remain within persistence bounds", () => {
  const classification = {
    type: "ledes",
    taskCode: "L".repeat(DESKTOP_BILLING_DRAFT_LIMITS.codeLength),
    activityCode: "A".repeat(DESKTOP_BILLING_DRAFT_LIMITS.codeLength),
  } as const;
  const drafts = response.drafts.map((draft) => ({ ...draft, classification }));
  const checkedGuidelines = Array.from(
    { length: DESKTOP_BILLING_DRAFT_LIMITS.guidelines },
    () => ({ fileId: "rules", fileName: "Guidelines" }),
  );
  expect(
    v.safeParse(desktopBillingDraftResponseSchema, {
      mode: "guided",
      drafts,
      checkedGuidelines,
    }).success,
  ).toBe(true);
  expect(
    v.safeParse(desktopBillingDraftResponseSchema, {
      mode: "guided",
      drafts,
      checkedGuidelines: [
        ...checkedGuidelines,
        { fileId: "extra", fileName: "Extra" },
      ],
    }).success,
  ).toBe(false);
  for (const invalid of [
    { ...classification, taskCode: `${classification.taskCode}X` },
    { ...classification, activityCode: `${classification.activityCode}X` },
  ]) {
    expect(
      v.safeParse(desktopBillingDraftResponseSchema, {
        mode: "guided",
        drafts: drafts.map((draft) => ({ ...draft, classification: invalid })),
        checkedGuidelines,
      }).success,
    ).toBe(false);
  }
});

test("the review returns the model result beside only the cited entry fields", () => {
  const earlier = {
    id: "earlier-entry",
    dateWorked: "2026-10-01",
    durationMinutes: 30,
    narrative: "Reviewed agreement",
  };
  const review = { result: response, earlierEntries: [earlier] };
  expect(v.parse(desktopBillingDraftReviewSchema, review)).toEqual(review);
  for (const extra of [
    { matterId: "00000000-0000-4000-8000-000000000001" },
    { userId: "another-user" },
    { taskCode: "L120" },
  ]) {
    expect(
      v.safeParse(desktopBillingDraftReviewSchema, {
        ...review,
        earlierEntries: [{ ...earlier, ...extra }],
      }).success,
    ).toBe(false);
  }
  expect(
    v.safeParse(desktopBillingDraftReviewSchema, { ...review, timeline: [] })
      .success,
  ).toBe(false);
});

test("model grammar preserves shape while canonical validation enforces every response bound", () => {
  expect(
    v.parse(desktopBillingDraftModelResponseSchema, modelShape(response)),
  ).toEqual(modelShape(response));
  const draft = response.drafts.at(0);
  assert.ok(draft);
  for (const invalidDraft of [
    { ...draft, entryId: "" },
    {
      ...draft,
      narrative: "x".repeat(DESKTOP_BILLING_DRAFT_LIMITS.narrativeLength + 1),
    },
    {
      ...draft,
      matchedEarlierEntryIds: Array.from(
        { length: DESKTOP_BILLING_DRAFT_LIMITS.matchedEarlierEntries + 1 },
        () => "entry",
      ),
    },
    {
      ...draft,
      operations: [
        {
          type: "move",
          targetMatterId: "invalid",
          targetMatterName: "",
          durationMinutes: 1,
          narrative: "Move",
          classification: draft.classification,
          billable: true,
        },
      ],
    },
    {
      ...draft,
      operations: [
        {
          type: "move",
          targetMatterId: entry.matterId,
          targetMatterName: "",
          durationMinutes: 1.5,
          narrative: "Move",
          classification: draft.classification,
          billable: true,
        },
      ],
    },
  ]) {
    const value = { ...response, drafts: [invalidDraft] };
    expect(
      v.safeParse(desktopBillingDraftModelResponseSchema, modelShape(value))
        .success,
    ).toBe(true);
    expect(v.safeParse(desktopBillingDraftResponseSchema, value).success).toBe(
      false,
    );
  }
  for (const invalidDraft of [
    {
      ...draft,
      classification: { type: "activity_group", activityGroup: "unknown" },
    },
    { ...draft, unexpected: true },
    { ...draft, operations: [{ type: "execute" }] },
    {
      ...draft,
      operations: [
        {
          type: "move",
          targetMatterId: "x".repeat(
            DESKTOP_BILLING_DRAFT_LIMITS.matterIdLength + 1,
          ),
          targetMatterName: "Matter",
          durationMinutes: 1,
          narrative: "Move",
          classification: draft.classification,
          billable: true,
        },
      ],
    },
  ]) {
    const value = { ...response, drafts: [invalidDraft] };
    expect(
      v.safeParse(desktopBillingDraftModelResponseSchema, modelShape(value))
        .success,
    ).toBe(false);
    expect(v.safeParse(desktopBillingDraftResponseSchema, value).success).toBe(
      false,
    );
  }
});
