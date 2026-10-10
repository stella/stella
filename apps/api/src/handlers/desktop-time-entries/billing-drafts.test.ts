import { Result } from "better-result";
import { afterEach, beforeEach, expect, test } from "bun:test";
import Elysia from "elysia";

import { desktopBillingDraftResponseSchema } from "@stll/api-contract/desktop-billing-drafts";
import type {
  DesktopBillingDraftRequest,
  DesktopBillingDraftResponse,
} from "@stll/api-contract/desktop-billing-drafts";

import { env } from "@/api/env";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { withActionAdmission } from "@/api/lib/rate-limit/action-admission";
import type { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import {
  createBillingDraftReferenceMap,
  createDesktopBillingDraftEndpoint,
} from "./billing-drafts";
import type { loadBillingDraftContext } from "./billing-drafts-context";

const MATTER_ID = toSafeId<"workspace">("00000000-0000-4000-8000-000000000001");
const EARLIER_ID = toSafeId<"timeEntry">(
  "00000000-0000-4000-8000-000000000002",
);
const GUIDELINE_ID = toSafeId<"agentSkillResource">(
  "00000000-0000-4000-8000-000000000003",
);
const USER_ID = toSafeId<"user">("billing-drafter");
const ORGANIZATION_ID = toSafeId<"organization">("billing-firm");
const previousGrants = env.API_FEATURE_ACCESS_GRANTS;
const previousTimeBilling = env.FEATURE_TIME_BILLING;
beforeEach(() => {
  env.FEATURE_TIME_BILLING = true;
  env.API_FEATURE_ACCESS_GRANTS = {
    "activity-timeline": [
      {
        type: "member",
        organizationId: ORGANIZATION_ID,
        email: "billing@example.test",
      },
    ],
  };
});
afterEach(() => {
  env.FEATURE_TIME_BILLING = previousTimeBilling;
  env.API_FEATURE_ACCESS_GRANTS = previousGrants;
});
const body: DesktopBillingDraftRequest = {
  entries: [
    {
      matterId: MATTER_ID,
      date: "2026-10-09",
      timezone: "Europe/Prague",
      durationMinutes: 30,
      appNames: ["Editor"],
      evidence: { documentNames: ["Agreement"], emailSubjects: [] },
    },
  ],
};
const context = {
  matters: [
    {
      matterId: MATTER_ID,
      name: "Matter",
      clientId: null,
      narrativeLanguage: "cs",
      ledesEnabled: false,
    },
  ],
  earlierEntries: [
    {
      id: EARLIER_ID,
      matterId: MATTER_ID,
      dateWorked: "2026-10-01",
      durationMinutes: 30,
      narrative: "Reviewed agreement",
      taskCode: null,
      activityCode: null,
      activityGroup: "client" as const,
    },
  ],
  guidelines: [
    {
      fileId: GUIDELINE_ID,
      fileName: "knowledge/billing.md",
      content: "# Narratives\nDescribe the purpose.",
      sections: ["Narratives"],
    },
  ],
  preference: "Keep it short",
  orgAIConfig: null,
  promptCachingEnabled: false,
  managedAIResidency: "eu" as const,
};
const fixture: DesktopBillingDraftResponse = {
  drafts: [
    {
      entryId: "entry_1",
      narrative: "Revize smlouvy",
      classification: { type: "activity_group", activityGroup: "client" },
      flags: [
        {
          text: "Describe the purpose",
          ruleRef: {
            fileId: GUIDELINE_ID,
            fileName: "knowledge/billing.md",
            section: "Narratives",
          },
        },
      ],
      matchedEarlierEntryIds: [EARLIER_ID],
      operations: [],
    },
  ],
  checkedGuidelines: [
    { fileId: GUIDELINE_ID, fileName: "knowledge/billing.md" },
  ],
};

type ExerciseOptions = {
  input?: unknown;
  refused?: boolean;
  hiddenFeature?: boolean;
  malformedResult?: boolean;
};
const exercise = async ({
  input = body,
  refused,
  hiddenFeature,
  malformedResult,
}: ExerciseOptions = {}) => {
  const calls: { prompt: string; schema: unknown; region: unknown }[] = [];
  const { scopedDb } = createScopedDbMock(
    {},
    {
      featureAccess: {
        identity: { email: "billing@example.test", emailVerified: true },
        enrolments: hiddenFeature
          ? []
          : [
              {
                featureId: "time-billing",
                organizationId: ORGANIZATION_ID,
                userId: USER_ID,
              },
            ],
      },
    },
  );
  const generate = async (
    options: Parameters<typeof generateTanStackObjectForRole>[0],
  ) => {
    calls.push({
      prompt: options.prompt ?? "",
      schema: options.outputSchema,
      region:
        options.dataClass === "customer" ? options.managedAIResidency : null,
    });
    const refs = createBillingDraftReferenceMap([
      "entry_1",
      MATTER_ID,
      EARLIER_ID,
      GUIDELINE_ID,
    ]);
    const result: unknown = JSON.parse(refs.serialize(fixture));
    if (malformedResult) {
      return { drafts: [], checkedGuidelines: [] };
    }
    return result;
  };
  const endpoint = createDesktopBillingDraftEndpoint({
    authorizeAccount: async () =>
      Result.ok({
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        keyId: "linked-desktop",
        memberRole: sessionMemberRole("member"),
        scopedDb,
      }),
    loadContext: asTestRaw<typeof loadBillingDraftContext>(async () =>
      refused
        ? Result.err(new HandlerError({ status: 403, message: "Refused" }))
        : Result.ok(context),
    ),
    generateObjectForRole:
      asTestRaw<typeof generateTanStackObjectForRole>(generate),
    admit: asTestRaw<typeof withActionAdmission>(
      async ({ run }: Parameters<typeof withActionAdmission>[0]) =>
        Result.ok(
          await run(new AbortController().signal, {
            reservePeriod: async () => Result.ok(undefined),
          }),
        ),
    ),
  });
  // A parent may enable normalization; strict Standard Schema must still reject extras.
  const app = new Elysia({ normalize: true }).post(
    "/drafts",
    endpoint.handler,
    { body: endpoint.config.body, response: endpoint.config.response },
  );
  const response = await app.handle(
    new Request("http://localhost/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return { response, calls };
};

test("one structured request uses selected evidence, region and opaque references", async () => {
  const { response, calls } = await exercise();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(fixture);
  expect(calls).toHaveLength(1);
  expect(calls.at(0)?.schema).toBe(desktopBillingDraftResponseSchema);
  expect(calls.at(0)?.region).toBe("eu");
  expect(calls.at(0)?.prompt).toContain("Agreement");
  expect(calls.at(0)?.prompt).not.toContain(MATTER_ID);
  expect(calls.at(0)?.prompt).not.toContain("timeline");
});

test("refused context and hidden feature never dispatch the model", async () => {
  for (const options of [{ refused: true }, { hiddenFeature: true }]) {
    const { response, calls } = await exercise(options);
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  }
});

test("strict body rejects privacy extras even under parent normalization", async () => {
  const { response, calls } = await exercise({
    input: { ...body, timeline: [] },
  });
  expect(response.status).toBe(422);
  expect(calls).toHaveLength(0);
});

test("invalid timezone and previous references refuse before generation", async () => {
  for (const input of [
    {
      entries: body.entries.map((entry) => ({
        ...entry,
        timezone: "invalid/timezone",
      })),
    },
    {
      ...body,
      steer: "Shorter",
      previousResult: { ...fixture, checkedGuidelines: [] },
    },
  ]) {
    const { response, calls } = await exercise({ input });
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  }
});

test("steering round-trips only selected previous suggestions in one call", async () => {
  const { response, calls } = await exercise({
    input: { ...body, steer: "Shorter", previousResult: fixture },
  });
  expect(response.status).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls.at(0)?.prompt).toContain('"steer":"Shorter"');
  expect(calls.at(0)?.prompt).toContain('"previousResult"');
});

test("malformed model output is refused", async () => {
  const { response, calls } = await exercise({ malformedResult: true });
  expect(response.status).toBe(502);
  expect(calls).toHaveLength(1);
});

test("opaque references remain UUID-compatible, collision-free and confined to reference fields", () => {
  const collision = "f0000000-0000-4000-8000-000000000001";
  const refs = createBillingDraftReferenceMap([
    "entry_1",
    MATTER_ID,
    EARLIER_ID,
    GUIDELINE_ID,
    collision,
  ]);
  const modelResult = asTestRaw<DesktopBillingDraftResponse>(
    JSON.parse(refs.serialize(fixture)),
  );
  const draft = modelResult.drafts.at(0);
  if (!draft) {
    throw new HandlerError({ status: 500, message: "Fixture has no draft" });
  }
  const targetAlias: unknown = JSON.parse(refs.serialize(collision));
  if (typeof targetAlias !== "string") {
    throw new HandlerError({
      status: 500,
      message: "Fixture has no reference",
    });
  }
  expect(targetAlias).not.toBe(collision);
  expect(targetAlias).toMatch(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u);
  draft.narrative = targetAlias;
  draft.operations = [
    {
      type: "move",
      targetMatterId: targetAlias,
      durationMinutes: 15,
      narrative: targetAlias,
      classification: { type: "activity_group", activityGroup: "client" },
      billable: true,
    },
  ];
  const restored = refs.restore(modelResult);
  expect(restored.drafts.at(0)?.narrative).toBe(targetAlias);
  expect(restored.drafts.at(0)?.operations.at(0)).toEqual({
    type: "move",
    targetMatterId: collision,
    durationMinutes: 15,
    narrative: targetAlias,
    classification: { type: "activity_group", activityGroup: "client" },
    billable: true,
  });
  draft.entryId = "unknown-alias";
  expect(() => refs.restore(modelResult)).toThrow(
    "Billing draft contains an unknown reference",
  );
});
