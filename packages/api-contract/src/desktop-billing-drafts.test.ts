import { toJsonSchema } from "@valibot/to-json-schema";
import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import * as v from "valibot";

import {
  DESKTOP_BILLING_DRAFT_LIMITS,
  desktopBillingDraftEntrySchema,
  desktopBillingDraftEvidenceSchema,
  desktopBillingDraftModelResponseSchema,
  type DesktopBillingDraftOperation,
  desktopBillingDraftOperationSchema,
  type DesktopBillingDraftRequest,
  desktopBillingDraftRequestSchema,
  type DesktopBillingDraftResponse,
  desktopBillingDraftResponseSchema,
  desktopBillingDraftReviewSchema,
  type DesktopBillingDraftSettingsRequest,
  desktopBillingDraftSettingsRequestSchema,
  desktopBillingDraftSettingsResponseSchema,
} from "./desktop-billing-drafts";
import { DESKTOP_TIME_ENTRY_CODE_MAX_LENGTH } from "./desktop-time-entries";

const entry = {
  matterId: "12345678-1234-4123-8123-123456789abc",
  date: "2026-10-09",
  timezone: "Europe/Prague",
  durationMinutes: 30,
  appNames: ["Editor"],
  evidence: { documentNames: ["Agreement.docx"], windowTitles: ["Review"] },
} satisfies DesktopBillingDraftRequest["entries"][number];

const response = {
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
} satisfies DesktopBillingDraftResponse;

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
    "entryId",
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
  for (const schema of [
    desktopBillingDraftResponseSchema,
    desktopBillingDraftSettingsResponseSchema,
  ]) {
    const jsonSchema = toJsonSchema(schema);
    const serialized = JSON.stringify(jsonSchema);
    for (const unsupported of ["$ref", "allOf", "oneOf", "not"]) {
      expect(serialized).not.toContain(`"${unsupported}":`);
    }
    expect(jsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
  }
});

test("billing drafting settings accept only personal consent and bounded preferences", () => {
  for (const patch of [
    { consent: "granted" },
    { consent: "revoked" },
    { preference: "Use concise Czech narratives" },
    { preference: null },
    { consent: "granted", preference: "Client-friendly wording" },
  ] satisfies DesktopBillingDraftSettingsRequest[]) {
    expect(v.parse(desktopBillingDraftSettingsRequestSchema, patch)).toEqual(
      patch,
    );
  }
  for (const patch of [
    {},
    { consent: "pending" },
    { organizationMode: "enabled" },
    { consent: "granted", userId: "another-user" },
    { preference: "" },
    { preference: "x".repeat(DESKTOP_BILLING_DRAFT_LIMITS.steerLength + 1) },
    { preference: "text\u0000text" },
  ]) {
    expect(
      v.safeParse(desktopBillingDraftSettingsRequestSchema, patch).success,
    ).toBe(false);
  }
  for (const organizationMode of ["enabled", "disabled"] as const) {
    for (const consent of ["granted", "revoked"] as const) {
      const settings = { organizationMode, consent, preference: null };
      expect(
        v.parse(desktopBillingDraftSettingsResponseSchema, settings),
      ).toEqual(settings);
    }
  }
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
    expect(v.parse(desktopBillingDraftModelResponseSchema, value)).toEqual(
      value,
    );
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
    taskCode: "L".repeat(DESKTOP_TIME_ENTRY_CODE_MAX_LENGTH),
    activityCode: "A".repeat(DESKTOP_TIME_ENTRY_CODE_MAX_LENGTH),
  } as const;
  const drafts = response.drafts.map((draft) => ({ ...draft, classification }));
  const checkedGuidelines = Array.from(
    { length: DESKTOP_BILLING_DRAFT_LIMITS.guidelines },
    () => ({ fileId: "rules", fileName: "Guidelines" }),
  );
  expect(
    v.safeParse(desktopBillingDraftResponseSchema, {
      drafts,
      checkedGuidelines,
    }).success,
  ).toBe(true);
  expect(
    v.safeParse(desktopBillingDraftResponseSchema, {
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
  expect(v.parse(desktopBillingDraftModelResponseSchema, response)).toEqual(
    response,
  );
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
      v.safeParse(desktopBillingDraftModelResponseSchema, value).success,
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
      v.safeParse(desktopBillingDraftModelResponseSchema, value).success,
    ).toBe(false);
    expect(v.safeParse(desktopBillingDraftResponseSchema, value).success).toBe(
      false,
    );
  }
});

test("desktop billing response boundaries validate through Standard Schema", async () => {
  for (const { schema, valid, invalid } of [
    {
      schema: desktopBillingDraftSettingsResponseSchema,
      valid: [
        { organizationMode: "enabled", consent: "granted", preference: null },
        {
          organizationMode: "disabled",
          consent: "revoked",
          preference: "Concise",
        },
      ],
      invalid: [
        { consent: "granted", preference: null },
        { organizationMode: "enabled", consent: "unknown", preference: null },
        {
          organizationMode: "enabled",
          consent: "granted",
          preference: null,
          extra: true,
        },
      ],
    },
    {
      schema: desktopBillingDraftReviewSchema,
      valid: [{ result: response, earlierEntries: [] }],
      invalid: [
        { earlierEntries: [] },
        { result: response, earlierEntries: [], extra: true },
        {
          result: {
            ...response,
            drafts: response.drafts.map((draft) => ({
              ...draft,
              classification: { type: "unknown" },
            })),
          },
          earlierEntries: [],
        },
      ],
    },
  ]) {
    for (const value of valid) {
      const parsed = await schema["~standard"].validate(value);
      expect(parsed.issues).toBeUndefined();
      expect(parsed).toMatchObject({ value });
    }
    for (const value of invalid) {
      expect((await schema["~standard"].validate(value)).issues).toBeDefined();
    }
  }
});
