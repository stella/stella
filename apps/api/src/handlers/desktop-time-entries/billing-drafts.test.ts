import { Result } from "better-result";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import fc from "fast-check";
import assert from "node:assert/strict";
import * as v from "valibot";

import {
  DESKTOP_BILLING_DRAFT_LIMITS,
  DESKTOP_BILLING_DRAFT_REFUSAL_CODE,
  desktopBillingDraftModelResponseSchema,
  desktopBillingDraftResponseSchema,
  desktopBillingDraftReviewSchema,
  desktopBillingPlainDraftModelResponseSchema,
} from "@stll/api-contract/desktop-billing-drafts";
import type {
  DesktopBillingDraftRequest,
  DesktopBillingDraftResponse,
  DesktopBillingGuidedDraftResponse,
  DesktopBillingPlainDraftResponse,
} from "@stll/api-contract/desktop-billing-drafts";
import { assertProperty } from "@stll/property-testing";
import { createTestState } from "@stll/test-state";

import { env } from "@/api/env";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { withActionAdmission } from "@/api/lib/rate-limit/action-admission";
import type { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
import { createDesktopBillingDraftRequest } from "@/api/tests/helpers/desktop-billing-draft";
import {
  claimFixtureDeviceProof,
  createDesktopDeviceSigner,
} from "@/api/tests/helpers/desktop-device-proof";
import { serveForTest, type TestServer } from "@/api/tests/helpers/test-server";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import type { BillingDraftGate } from "./billing-draft-mode";
import {
  type BillingDraftPrompt,
  createBillingDraftReferenceMap,
  createDesktopBillingDraftEndpoint,
} from "./billing-drafts";
import type { loadBillingDraftContext } from "./billing-drafts-context";

const testState = createTestState({ file: import.meta.path, config: env });

const servers: TestServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map(async (server) => await server.stop()));
});

const MATTER_ID = toSafeId<"workspace">("abcdefab-cdef-4abc-8abc-abcdefabcdef");
const EARLIER_ID = toSafeId<"timeEntry">(
  "00000000-0000-4000-8000-000000000002",
);
const GUIDELINE_ID = toSafeId<"agentSkillResource">(
  "00000000-0000-4000-8000-000000000003",
);
const USER_ID = toSafeId<"user">("billing-drafter");
const ORGANIZATION_ID = toSafeId<"organization">("billing-firm");
beforeEach(() => {
  testState.setConfig("FEATURE_TIME_BILLING", true);
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "activity-timeline": [
      {
        type: "member",
        organizationId: ORGANIZATION_ID,
        email: "billing@example.test",
      },
    ],
  });
});
const body = createDesktopBillingDraftRequest({
  matterId: MATTER_ID,
  entry: {
    evidence: { documentNames: ["Agreement"], windowTitles: [] },
  },
});
const context = {
  mode: "guided" as const,
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
      taskCode: "L110",
      activityCode: "A101",
      activityGroup: "client" as const,
    },
  ],
  guidelines: [
    {
      fileId: GUIDELINE_ID,
      fileName: "references/billing.md",
      content: "# Narratives\nDescribe the purpose.",
      sections: ["Narratives"],
    },
  ],
  preference: "Keep it short",
  orgAIConfig: null,
  promptCachingEnabled: false,
  managedAIResidency: "eu" as const,
};
// No firm guideline file is bound: the context carries no guidelines and no
// classification of earlier entries at all.
const plainContext = {
  mode: "plain" as const,
  matters: context.matters,
  earlierEntries: context.earlierEntries.map(
    ({ id, matterId, dateWorked, durationMinutes, narrative }) => ({
      id,
      matterId,
      dateWorked,
      durationMinutes,
      narrative,
    }),
  ),
  preference: context.preference,
  orgAIConfig: context.orgAIConfig,
  promptCachingEnabled: context.promptCachingEnabled,
  managedAIResidency: context.managedAIResidency,
};
const plainFixture: DesktopBillingPlainDraftResponse = {
  mode: "plain",
  drafts: [
    {
      entryId: "entry_1",
      narrative: "Revize smlouvy",
      matchedEarlierEntryIds: [EARLIER_ID],
    },
  ],
};
const asGuided = (value: DesktopBillingDraftResponse) => {
  if (value.mode !== "guided") {
    throw new HandlerError({
      status: 500,
      message: "Fixture is not a guided result",
    });
  }
  return value;
};
const fixture: DesktopBillingGuidedDraftResponse = {
  mode: "guided",
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
            fileName: "references/billing.md",
            section: "Narratives",
          },
        },
      ],
      matchedEarlierEntryIds: [EARLIER_ID],
      operations: [],
    },
  ],
  checkedGuidelines: [
    { fileId: GUIDELINE_ID, fileName: "references/billing.md" },
  ],
};

type ExerciseOptions = {
  input?: unknown;
  refused?: boolean;
  hiddenFeature?: boolean;
  malformedResult?: boolean;
  unknownReference?: boolean;
  copyPromptGuideline?: boolean;
  output?: DesktopBillingDraftResponse;
  draftContext?: typeof context | typeof plainContext;
  /** What each successive gate read answers; the last one repeats. */
  gates?: readonly BillingDraftGate[];
};
const consenting: BillingDraftGate = {
  organizationMode: "enabled",
  consentAt: new Date("2026-10-01T12:00:00Z"),
  preference: context.preference,
};
const exercise = async ({
  input = body,
  refused,
  hiddenFeature,
  malformedResult,
  unknownReference,
  copyPromptGuideline,
  output = fixture,
  draftContext = context,
  gates = [consenting],
}: ExerciseOptions = {}) => {
  const calls: {
    prompt: string;
    system: string;
    schema: unknown;
    region: unknown;
  }[] = [];
  const receivedBodies: DesktopBillingDraftRequest[] = [];
  let gateReads = 0;
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
  const generate = mock(
    async (options: Parameters<typeof generateTanStackObjectForTask>[0]) => {
      calls.push({
        prompt: options.prompt ?? "",
        system: options.system ?? "",
        schema: options.outputSchema,
        region:
          options.dataClass === "customer" ? options.managedAIResidency : null,
      });
      const refs = createBillingDraftReferenceMap([
        ...(receivedBodies.at(0)?.entries.map(({ entryId }) => entryId) ?? [
          "entry_1",
        ]),
        ...draftContext.matters.map(({ matterId }) => matterId),
        EARLIER_ID,
        GUIDELINE_ID,
      ]);
      if (malformedResult) {
        return { drafts: [], checkedGuidelines: [] };
      }
      const result = refs.aliasResponse(output);
      if (result.mode === "plain") {
        return result;
      }
      if (copyPromptGuideline) {
        const prompt = asTestRaw<BillingDraftPrompt>(
          JSON.parse(options.prompt ?? "{}"),
        );
        if (prompt.mode !== "guided") {
          throw new HandlerError({
            status: 500,
            message: "Prompt carries no guidelines",
          });
        }
        const guideline = prompt.guidelines.at(0);
        const section = guideline?.sections.at(0);
        if (!guideline || !section) {
          throw new HandlerError({
            status: 500,
            message: "Fixture has no guideline section",
          });
        }
        result.checkedGuidelines = [
          { fileId: guideline.fileId, fileName: guideline.fileName },
        ];
        result.drafts = result.drafts.map((draft) => ({
          ...draft,
          flags: draft.flags.map((flag) => ({
            ...flag,
            ruleRef: {
              fileId: guideline.fileId,
              fileName: guideline.fileName,
              section,
            },
          })),
        }));
      }
      if (unknownReference) {
        result.checkedGuidelines = result.checkedGuidelines.map((file) => ({
          ...file,
          fileId: "unknown-reference",
        }));
      }
      return result;
    },
  );
  const endpoint = createDesktopBillingDraftEndpoint({
    authorizeAccount: async (request) => {
      const device = await createDesktopDeviceSigner();
      return Result.ok({
        featureAccessSnapshot: buildFeatureAccessSnapshot({
          organizationId: ORGANIZATION_ID,
          userId: USER_ID,
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
        }),
        consumedProof: await claimFixtureDeviceProof({
          request: await device.signRequest({
            request,
            credential: "billing-draft-fixture",
          }),
          deviceJkt: device.deviceJkt,
          keyId: "linked-desktop",
          credential: "billing-draft-fixture",
        }),
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        keyId: "linked-desktop",
        memberRole: sessionMemberRole("member"),
        scopedDb,
      });
    },
    loadGate: async () => {
      const gate = gates.at(Math.min(gateReads, gates.length - 1));
      gateReads += 1;
      return Result.ok(gate ?? consenting);
    },
    loadContext: asTestRaw<typeof loadBillingDraftContext>(
      async ({
        body: requestBody,
      }: Parameters<typeof loadBillingDraftContext>[0]) => {
        receivedBodies.push(requestBody);
        return refused
          ? Result.err(new HandlerError({ status: 403, message: "Refused" }))
          : Result.ok(draftContext);
      },
    ),
    generateObjectForTask:
      asTestRaw<typeof generateTanStackObjectForTask>(generate),
    admit: asTestRaw<typeof withActionAdmission>(
      async ({ run }: Parameters<typeof withActionAdmission>[0]) =>
        Result.ok(
          await run(new AbortController().signal, {
            reservePeriod: async () => Result.ok(undefined),
          }),
        ),
    ),
  });
  const server = serveForTest(
    createHttpApp({
      middleware: [errorBoundary],
      routes: routes({ "/drafts": { POST: endpoint } }),
    }),
  );
  servers.push(server);
  const response = await server.fetch(
    new Request("http://localhost/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return {
    response,
    calls,
    receivedBodies,
    generate,
    gateReads: () => gateReads,
  };
};

test("one structured request uses selected evidence, region and opaque references", async () => {
  const { response, calls } = await exercise();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    result: fixture,
    earlierEntries: [
      {
        id: EARLIER_ID,
        dateWorked: "2026-10-01",
        durationMinutes: 30,
        narrative: "Reviewed agreement",
      },
    ],
  });
  expect(calls).toHaveLength(1);
  expect(calls.at(0)?.schema).toBe(desktopBillingDraftModelResponseSchema);
  expect(calls.at(0)?.region).toBe("eu");
  expect(calls.at(0)?.prompt).toContain("Agreement");
  expect(calls.at(0)?.prompt).not.toContain(MATTER_ID);
  expect(calls.at(0)?.prompt).not.toContain("timeline");
});

test("without guideline files a consenting user gets plain descriptions with no billing fields", async () => {
  const { response, calls } = await exercise({
    draftContext: plainContext,
    output: plainFixture,
  });
  expect(response.status).toBe(200);
  const review: unknown = await response.json();
  expect(review).toEqual({
    result: plainFixture,
    earlierEntries: [
      {
        id: EARLIER_ID,
        dateWorked: "2026-10-01",
        durationMinutes: 30,
        narrative: "Reviewed agreement",
      },
    ],
  });
  const { result } = v.parse(desktopBillingDraftReviewSchema, review);
  expect(result.mode).toBe("plain");
  expect(result).not.toHaveProperty("checkedGuidelines");
  for (const absent of ["classification", "flags", "operations"]) {
    expect(result.drafts.at(0)).not.toHaveProperty(absent);
  }
  expect(calls).toHaveLength(1);
  expect(calls.at(0)?.schema).toBe(desktopBillingPlainDraftModelResponseSchema);
  const prompt = asTestRaw<BillingDraftPrompt>(
    JSON.parse(calls.at(0)?.prompt ?? "{}"),
  );
  expect(prompt.mode).toBe("plain");
  for (const absent of ["guidelines", "activityGroups"]) {
    expect(prompt).not.toHaveProperty(absent);
  }
  expect(prompt.matters.at(0)).not.toHaveProperty("ledesEnabled");
  // No LEDES setting, code or classification reaches the model in plain
  // mode, neither in the instructions nor in the earlier entries.
  for (const absent of ["taskCode", "activityCode", "activityGroup"]) {
    expect(prompt.earlierEntries.at(0)).not.toHaveProperty(absent);
  }
  for (const code of ["L110", "A101", "ledes"]) {
    expect(calls.at(0)?.prompt).not.toContain(code);
  }
  expect(calls.at(0)?.system).not.toMatch(/ledes|utbms|task\/activity/iu);
});

test("guided mode still hands the model each earlier entry's codes", async () => {
  const { response, calls } = await exercise();
  expect(response.status).toBe(200);
  const prompt = asTestRaw<BillingDraftPrompt>(
    JSON.parse(calls.at(0)?.prompt ?? "{}"),
  );
  assert.ok(prompt.mode === "guided");
  expect(prompt.earlierEntries.at(0)).toMatchObject({
    taskCode: "L110",
    activityCode: "A101",
  });
  expect(calls.at(0)?.system).toContain("UTBMS");
});

test("the organization's off switch stops plain and guided drafting before context or model", async () => {
  for (const draftContext of [context, plainContext]) {
    const { response, calls, receivedBodies } = await exercise({
      draftContext,
      gates: [{ ...consenting, organizationMode: "disabled" }],
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: DESKTOP_BILLING_DRAFT_REFUSAL_CODE.organizationOff,
    });
    expect(receivedBodies).toHaveLength(0);
    expect(calls).toHaveLength(0);
  }
});

test("drafting without personal consent is refused before context or model", async () => {
  const { response, calls, receivedBodies } = await exercise({
    draftContext: plainContext,
    gates: [{ ...consenting, consentAt: null }],
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    code: DESKTOP_BILLING_DRAFT_REFUSAL_CODE.consentRequired,
  });
  expect(receivedBodies).toHaveLength(0);
  expect(calls).toHaveLength(0);
});

test("a consent withdrawn or a switch turned off while the context loads stops the model call", async () => {
  for (const [later, code] of [
    [
      { ...consenting, consentAt: null },
      DESKTOP_BILLING_DRAFT_REFUSAL_CODE.consentRequired,
    ],
    [
      { ...consenting, organizationMode: "disabled" },
      DESKTOP_BILLING_DRAFT_REFUSAL_CODE.organizationOff,
    ],
  ] as const) {
    const { response, calls, receivedBodies, gateReads } = await exercise({
      draftContext: plainContext,
      output: plainFixture,
      gates: [consenting, later],
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code });
    // The context was read under the first answer; the model never ran.
    expect(receivedBodies).toHaveLength(1);
    expect(gateReads()).toBe(2);
    expect(calls).toHaveLength(0);
  }
});

test("a consenting request reads the gate again right before the model call", async () => {
  const { response, calls, gateReads } = await exercise({
    draftContext: plainContext,
    output: plainFixture,
  });
  expect(response.status).toBe(200);
  expect(gateReads()).toBe(2);
  expect(calls).toHaveLength(1);
});

test("plain mode refuses a model answer that carries billing fields", async () => {
  const { response, calls } = await exercise({
    draftContext: plainContext,
    output: fixture,
  });
  expect(calls).toHaveLength(1);
  expect(response.status).toBe(502);
});

test("a previous result from the other drafting mode is refused before generation", async () => {
  for (const [draftContext, previousResult] of [
    [plainContext, fixture],
    [context, plainFixture],
  ] as const) {
    const { response, calls } = await exercise({
      draftContext,
      input: { ...body, steer: "Shorter", previousResult },
    });
    expect(response.status).toBe(409);
    expect(calls).toHaveLength(0);
  }
});

test("a plain previous result steers a plain draft", async () => {
  const { response, calls } = await exercise({
    draftContext: plainContext,
    output: plainFixture,
    input: { ...body, steer: "Shorter", previousResult: plainFixture },
  });
  expect(response.status).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls.at(0)?.prompt).toContain('"previousResult"');
});

test("billing draft endpoint canonicalizes uppercase matter UUIDs before loading context", async () => {
  const uppercaseMatterId = MATTER_ID.toUpperCase();
  expect(uppercaseMatterId).not.toBe(MATTER_ID);
  const { response, receivedBodies } = await exercise({
    input: {
      entries: body.entries.map((entry) => ({
        ...entry,
        matterId: uppercaseMatterId,
      })),
    },
  });

  expect(response.status).toBe(200);
  expect(receivedBodies.at(0)?.entries.at(0)?.matterId).toBe(MATTER_ID);
});

test("mixed-case duplicate matters reach context loading with one canonical identity", async () => {
  const upperMatterId = MATTER_ID.toUpperCase();
  const lowerMatterId = MATTER_ID.toLowerCase();
  const input = {
    entries: [
      { ...body.entries[0], matterId: upperMatterId },
      {
        ...body.entries[0],
        entryId: "entry_2",
        matterId: lowerMatterId,
      },
    ],
  };
  const output: DesktopBillingDraftResponse = {
    ...fixture,
    drafts: [
      ...fixture.drafts.map((draft) => ({ ...draft, entryId: "entry_1" })),
      ...fixture.drafts.map((draft) => ({ ...draft, entryId: "entry_2" })),
    ],
  };
  const { response, receivedBodies } = await exercise({ input, output });
  const canonicalMatterIds =
    receivedBodies.at(0)?.entries.map(({ matterId }) => matterId) ?? [];

  expect(response.status).toBe(200);
  expect(canonicalMatterIds).toEqual([MATTER_ID, MATTER_ID]);
  expect(new Set(canonicalMatterIds).size).toBe(1);
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

test("duplicate selected entry identifiers refuse before context loading and generation", async () => {
  for (const entryCount of [2, DESKTOP_BILLING_DRAFT_LIMITS.entries]) {
    const { response, receivedBodies, generate } = await exercise({
      input: {
        entries: Array.from({ length: entryCount }, () => body.entries).flat(),
      },
    });

    expect(generate).toHaveBeenCalledTimes(0);
    expect(receivedBodies).toHaveLength(0);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: "validation",
      issues: [{ field: "entries", constraint: "invalid" }],
    });
  }
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

test("refining the second of two drafts preserves both stable entry identities", async () => {
  const baseDraft = fixture.drafts.at(0);
  if (!baseDraft) {
    throw new HandlerError({ status: 500, message: "Fixture has no draft" });
  }
  const secondEntry = {
    ...body.entries[0],
    entryId: "time-entry-b",
    durationMinutes: 45,
  };
  const firstDraft = { ...baseDraft, entryId: "time-entry-a" };
  const secondDraft = {
    ...baseDraft,
    entryId: secondEntry.entryId,
    narrative: "Second original draft",
  };
  const initial = await exercise({
    input: {
      entries: [
        { ...body.entries[0], entryId: firstDraft.entryId },
        secondEntry,
      ],
    },
    output: { ...fixture, drafts: [firstDraft, secondDraft] },
  });
  expect(initial.response.status).toBe(200);
  const initialReview = v.parse(
    desktopBillingDraftReviewSchema,
    await initial.response.json(),
  );

  const refinedSecond = {
    ...secondDraft,
    narrative: "Second refined draft",
  };
  const refinement = await exercise({
    input: {
      entries: [secondEntry],
      steer: "Make the second narrative shorter",
      previousResult: { ...fixture, drafts: [secondDraft] },
    },
    output: { ...fixture, drafts: [refinedSecond] },
  });
  expect(refinement.response.status).toBe(200);
  const refinedReview = v.parse(
    desktopBillingDraftReviewSchema,
    await refinement.response.json(),
  );
  const draftsByEntryId = new Map(
    initialReview.result.drafts.map((draft) => [draft.entryId, draft]),
  );
  for (const draft of refinedReview.result.drafts) {
    draftsByEntryId.set(draft.entryId, draft);
  }

  expect(draftsByEntryId.get(firstDraft.entryId)?.narrative).toBe(
    firstDraft.narrative,
  );
  expect(draftsByEntryId.get(secondEntry.entryId)?.narrative).toBe(
    refinedSecond.narrative,
  );
  expect([...draftsByEntryId.keys()]).toEqual([
    firstDraft.entryId,
    secondEntry.entryId,
  ]);
});

test("a previous result may cite fewer guideline files, never unknown ones", async () => {
  const withoutFlags = {
    ...fixture,
    drafts: fixture.drafts.map((draft) => ({ ...draft, flags: [] })),
    checkedGuidelines: [],
  };
  const narrowed = await exercise({
    input: { ...body, steer: "Shorter", previousResult: withoutFlags },
  });
  expect(narrowed.response.status).toBe(200);
  expect(narrowed.calls).toHaveLength(1);
  const unknown = await exercise({
    input: {
      ...body,
      steer: "Shorter",
      previousResult: {
        ...withoutFlags,
        checkedGuidelines: [
          { fileId: "unknown-file", fileName: "references/billing.md" },
        ],
      },
    },
  });
  expect(unknown.response.status).toBe(400);
  expect(unknown.calls).toHaveLength(0);
});

test("malformed model output is refused", async () => {
  const { response, calls } = await exercise({ malformedResult: true });
  expect(response.status).toBe(502);
  expect(calls).toHaveLength(1);
});

test("unknown model references return a bounded failure", async () => {
  const { response, calls } = await exercise({ unknownReference: true });
  expect(response.status).toBe(502);
  expect(calls).toHaveLength(1);
});

test("entry identifiers cannot rewrite guideline names, sections or discriminators", async () => {
  const entryIds = [
    "references/billing.md",
    "Narratives",
    "activity_group",
    "client",
  ];
  const entries = entryIds.flatMap((entryId) =>
    body.entries.map((entry) => ({ ...entry, entryId })),
  );
  const output = {
    ...fixture,
    drafts: entryIds.flatMap((entryId) =>
      fixture.drafts.map((draft) => ({ ...draft, entryId })),
    ),
  };
  const { response, calls } = await exercise({
    input: { entries, steer: "client", previousResult: output },
    output,
    copyPromptGuideline: true,
  });
  expect(response.status).toBe(200);
  expect(calls).toHaveLength(1);
  const prompt = asTestRaw<BillingDraftPrompt>(
    JSON.parse(calls.at(0)?.prompt ?? "{}"),
  );
  assert.ok(prompt.mode === "guided");
  expect(prompt.guidelines.at(0)).toMatchObject({
    fileName: "references/billing.md",
    sections: ["Narratives"],
  });
  assert.ok(prompt.previousResult?.mode === "guided");
  expect(prompt.previousResult.drafts.at(0)?.classification).toEqual({
    type: "activity_group",
    activityGroup: "client",
  });
  expect(prompt.steer).toBe("client");
  expect(await response.json()).toMatchObject({ result: output });
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
  const modelResult = asGuided(refs.aliasResponse(fixture));
  const draft = modelResult.drafts.at(0);
  if (!draft) {
    throw new HandlerError({ status: 500, message: "Fixture has no draft" });
  }
  const targetAlias = refs.alias(collision);
  expect(targetAlias).not.toBe(collision);
  expect(targetAlias).toMatch(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u);
  draft.narrative = targetAlias;
  draft.operations = [
    {
      type: "move",
      targetMatterId: targetAlias,
      targetMatterName: "Candidate matter",
      durationMinutes: 15,
      narrative: targetAlias,
      classification: { type: "activity_group", activityGroup: "client" },
      billable: true,
    },
  ];
  const restored = asGuided(refs.restore(modelResult).unwrap());
  expect(restored.drafts.at(0)?.narrative).toBe(targetAlias);
  expect(restored.drafts.at(0)?.operations.at(0)).toEqual({
    type: "move",
    targetMatterId: collision,
    targetMatterName: "Candidate matter",
    durationMinutes: 15,
    narrative: targetAlias,
    classification: { type: "activity_group", activityGroup: "client" },
    billable: true,
  });
  draft.entryId = "unknown-alias";
  const refused = refs.restore(modelResult);
  expect(refused.isErr()).toBe(true);
  if (refused.isErr()) {
    expect(refused.error).toMatchObject({
      status: 502,
      message: "Billing draft contains an unknown reference",
    });
  }
});

test("move proposals use the authorized target's canonical name", async () => {
  const targetId = toSafeId<"workspace">(
    "00000000-0000-4000-8000-000000000004",
  );
  const { response, calls } = await exercise({
    draftContext: {
      ...context,
      matters: [
        ...context.matters,
        {
          matterId: targetId,
          name: "Candidate matter",
          clientId: null,
          narrativeLanguage: "cs",
          ledesEnabled: false,
        },
      ],
    },
    output: {
      ...fixture,
      drafts: fixture.drafts.map(
        (draft): DesktopBillingGuidedDraftResponse["drafts"][number] => ({
          ...draft,
          operations: [
            {
              type: "move",
              targetMatterId: targetId,
              targetMatterName: "Model-supplied label",
              durationMinutes: 15,
              narrative: "Reviewed agreement",
              classification: {
                type: "activity_group",
                activityGroup: "client",
              },
              billable: true,
            },
          ],
        }),
      ),
    },
  });
  expect(response.status).toBe(200);
  expect(calls).toHaveLength(1);
  expect(await response.json()).toMatchObject({
    result: {
      drafts: [
        {
          operations: [
            {
              type: "move",
              targetMatterId: targetId,
              targetMatterName: "Candidate matter",
            },
          ],
        },
      ],
    },
  });
});

test("compact model output still passes canonical bounds before proposals are accepted", async () => {
  const { response, calls } = await exercise({
    output: {
      ...fixture,
      drafts: fixture.drafts.map((draft) => ({
        ...draft,
        narrative: "x".repeat(DESKTOP_BILLING_DRAFT_LIMITS.narrativeLength + 1),
      })),
    },
  });
  expect(calls).toHaveLength(1);
  expect(response.status).toBe(502);
});

test("billing reference mapping preserves every colliding text field", () => {
  assertProperty(
    "billing reference mapping preserves every colliding text field",
    fc.property(fc.string({ minLength: 1, maxLength: 20 }), (text) => {
      const classification = {
        type: "ledes",
        taskCode: text,
        activityCode: text,
      } as const;
      const part = {
        durationMinutes: 15,
        narrative: text,
        classification,
        billable: true,
      };
      const operations = [
        { type: "rewrite", narrative: text },
        { type: "change_classification", classification },
        { type: "set_billable", billable: true },
        { type: "split", parts: [part, part] },
        {
          type: "merge",
          entryIds: ["entry_1", "entry_2"],
          narrative: text,
          classification,
          billable: true,
        },
        {
          type: "move",
          targetMatterId: MATTER_ID,
          targetMatterName: text,
          ...part,
        },
      ] satisfies DesktopBillingGuidedDraftResponse["drafts"][number]["operations"];
      const output = {
        mode: "guided",
        checkedGuidelines: [{ fileId: GUIDELINE_ID, fileName: text }],
        drafts: [
          {
            entryId: "entry_1",
            narrative: text,
            classification,
            flags: [
              {
                text,
                fix: "split",
                ruleRef: {
                  fileId: GUIDELINE_ID,
                  fileName: text,
                  section: text,
                },
              },
            ],
            matchedEarlierEntryIds: [EARLIER_ID],
            operations,
          },
        ],
      } satisfies DesktopBillingGuidedDraftResponse;
      const prompt = {
        mode: "guided" as const,
        entries: body.entries.map((entry) => ({
          ...entry,
          appNames: [text],
          evidence: { documentNames: [text], windowTitles: [text] },
        })),
        steer: text,
        previousResult: output,
        personalPreference: text,
        matters: context.matters.map((matter) => ({ ...matter, name: text })),
        earlierEntries: context.earlierEntries.map((entry) => ({
          ...entry,
          narrative: text,
          taskCode: text,
          activityCode: text,
        })),
        guidelines: context.guidelines.map((file) => ({
          ...file,
          fileName: text,
          content: text,
          sections: [text],
          matterIds: [MATTER_ID],
        })),
        activityGroups: ["client"],
      } satisfies BillingDraftPrompt;
      // Every string, including discriminators and dates, is also an entry ID.
      const ids = new Set<string>();
      JSON.stringify(prompt, (_key, value: unknown) => {
        if (typeof value === "string") {
          ids.add(value);
        }
        return value;
      });
      prompt.entries = [...ids].flatMap((entryId) =>
        body.entries.map((entry) => ({
          ...entry,
          entryId,
          appNames: [text],
          evidence: { documentNames: [text], windowTitles: [text] },
        })),
      );
      const refs = createBillingDraftReferenceMap([...ids]);
      expect(v.parse(desktopBillingDraftResponseSchema, output)).toEqual(
        output,
      );
      const aliased = refs.aliasResponse(output);
      expect(aliased.drafts.at(0)).toMatchObject({
        narrative: text,
        classification,
        flags: [
          { text, fix: "split", ruleRef: { fileName: text, section: text } },
        ],
        operations: operations.map((operation) => {
          switch (operation.type) {
            case "merge": {
              const { entryIds: _ids, ...free } = operation;
              return free;
            }
            case "move": {
              const { targetMatterId: _id, ...free } = operation;
              return free;
            }
            case "rewrite":
            case "change_classification":
            case "set_billable":
            case "split":
              return operation;
            default:
              return operation satisfies never;
          }
        }),
      });
      expect(refs.restore(aliased).unwrap()).toEqual(output);
      const modelPrompt = refs.aliasPrompt(prompt);
      assert.ok(modelPrompt.mode === "guided");
      expect(JSON.parse(refs.serializePrompt(prompt))).toEqual(modelPrompt);
      expect(modelPrompt).toMatchObject({
        steer: text,
        personalPreference: text,
        activityGroups: ["client"],
        matters: [{ name: text, narrativeLanguage: "cs" }],
        earlierEntries: [
          {
            narrative: text,
            taskCode: text,
            activityCode: text,
            activityGroup: "client",
            dateWorked: "2026-10-01",
          },
        ],
        guidelines: [{ fileName: text, content: text, sections: [text] }],
      });
      expect(modelPrompt.previousResult).toEqual(aliased);
      for (const entry of modelPrompt.entries) {
        expect(entry).toMatchObject({
          appNames: [text],
          evidence: { documentNames: [text], windowTitles: [text] },
          date: body.entries.at(0)?.date,
          timezone: body.entries.at(0)?.timezone,
        });
      }
      expect(modelPrompt.entries.map(({ entryId }) => entryId)).toEqual(
        [...ids].map(refs.alias),
      );
      expect(modelPrompt.guidelines.at(0)?.matterIds).toEqual([
        refs.alias(MATTER_ID),
      ]);
      expect(modelPrompt.earlierEntries.at(0)?.id).toBe(refs.alias(EARLIER_ID));
      expect(modelPrompt.earlierEntries.at(0)?.matterId).toBe(
        refs.alias(MATTER_ID),
      );
      expect(modelPrompt.matters.at(0)?.matterId).toBe(refs.alias(MATTER_ID));
    }),
  );
});
