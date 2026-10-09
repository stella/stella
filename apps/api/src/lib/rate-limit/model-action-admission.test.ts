import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { ACTION_ADMISSION_CODES } from "@stll/api-contract/action-admission";

import { ORGANIZATION_ACCESS_STATE } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { OrganizationAccessSnapshot } from "@/api/lib/usage/organization-access-snapshot";
import {
  ORGANIZATION_MODEL_CREDENTIALS,
  type OrganizationActionState,
} from "@/api/lib/usage/organization-action-budget";
import { testOrganizationStateDb } from "@/api/tests/helpers/model-dispatch-admission";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { withActionAdmission } from "./action-admission";
import type { PeriodActionKind } from "./action-kinds";
import {
  createDetachedModelActionStarter,
  createModelActionAdmitter,
  modelActionRefusal,
} from "./model-action-admission";
import type { ModelDispatchAdmission } from "./model-dispatch-admission";
import { runScheduledBackgroundWork } from "./queued-action-admission";

const organizationId = toSafeId<"organization">("model_action_org");
const userId = toSafeId<"user">("model_action_user");
const nowMs = Date.UTC(2026, 9, 5, 12, 0);
const FREE_ACTIONS = 3;
const policy = {
  organizationConcurrency: 4,
  userConcurrency: 4,
  leaseMs: 120_000,
};
const serviceBudgetConfig = {
  periodMs: 86_400_000,
  evaluationActions: 7,
  selfManagedActions: 19,
};
const lapsedEvaluation = {
  state: ORGANIZATION_ACCESS_STATE.evaluationEnded,
  evaluationEndsAt: new Date(nowMs - 1),
} as const satisfies OrganizationAccessSnapshot;
const freeActionState = (
  modelCredentials: OrganizationActionState["modelCredentials"],
): OrganizationActionState => ({
  snapshot: lapsedEvaluation,
  freeTier: { status: "on", policy: { serviceActionsPerPeriod: FREE_ACTIONS } },
  modelCredentials,
});

// A period counter that refuses past the limit the admission passes, as the
// acquisition script does.
const countingRedis = () => {
  const commands: string[][] = [];
  let counted = 0;
  return {
    periodAcquisitions: () =>
      commands.filter((args) => args.at(1) === "3").length,
    client: {
      send: async (_command: string, args: string[]) => {
        commands.push(args);
        if (args.at(1) !== "3") {
          return 1;
        }
        counted += 1;
        return counted > Number(args.at(11)) ? -1 : 1;
      },
    },
  };
};

type FreeAdmissionOptions = {
  modelCredentials: OrganizationActionState["modelCredentials"];
  redis: ReturnType<typeof countingRedis>;
};

/** Admission as production runs it, on a free organization. */
const freeAdmission =
  ({
    modelCredentials,
    redis,
  }: FreeAdmissionOptions): typeof withActionAdmission =>
  async (options) =>
    await withActionAdmission({
      ...options,
      enabled: true,
      policy,
      serviceBudgetsEnabled: true,
      serviceBudgetConfig,
      budgetNow: () => nowMs,
      readOrganizationState: async () => freeActionState(modelCredentials),
      redis: redis.client,
    });

const admitterFor = ({
  actionKind,
  admit,
}: {
  actionKind: PeriodActionKind;
  admit: typeof withActionAdmission;
}) =>
  createModelActionAdmitter({
    organizationId,
    userId,
    organizationStateDb: createScopedDbMock({}).scopedDb,
    actionKind,
    admit,
  });

describe("model actions code starts on its own", () => {
  test("an admitted run carries the proof of its organization and kind", async () => {
    const redis = countingRedis();
    const proofs: ModelDispatchAdmission[] = [];
    const admitted = await admitterFor({
      actionKind: "playbooks.derive-ask",
      admit: freeAdmission({
        modelCredentials: ORGANIZATION_MODEL_CREDENTIALS.managed,
        redis,
      }),
    })(async ({ admission }) => {
      proofs.push(admission);
      return await Promise.resolve("derived");
    });
    expect(admitted).toEqual(Result.ok("derived"));
    expect(proofs).toEqual([
      expect.objectContaining({
        type: "organization",
        organizationId,
        actionKind: "playbooks.derive-ask",
      }),
    ]);
    expect(redis.periodAcquisitions()).toBe(1);
  });

  test("a free organization on managed models is refused once its budget is spent", async () => {
    const redis = countingRedis();
    const admit = admitterFor({
      actionKind: "templates.fill",
      admit: freeAdmission({
        modelCredentials: ORGANIZATION_MODEL_CREDENTIALS.managed,
        redis,
      }),
    });
    let runs = 0;
    const run = async () => {
      runs += 1;
      return await Promise.resolve(runs);
    };
    for (let action = 0; action < FREE_ACTIONS; action += 1) {
      expect(Result.isOk(await admit(run))).toBe(true);
    }
    const refused = await admit(run);
    expect(runs).toBe(FREE_ACTIONS);
    expect(Result.isError(refused)).toBe(true);
    if (Result.isError(refused)) {
      const answer = modelActionRefusal(refused.error);
      expect(answer).toBeInstanceOf(HandlerError);
      expect(answer).toMatchObject({
        code: ACTION_ADMISSION_CODES.periodExhausted,
        status: 403,
      });
    }
  });

  test("a free organization's own key runs without drawing the budget", async () => {
    const redis = countingRedis();
    const admit = admitterFor({
      actionKind: "case-law.analysis",
      admit: freeAdmission({
        modelCredentials: ORGANIZATION_MODEL_CREDENTIALS.organization,
        redis,
      }),
    });
    for (let action = 0; action < FREE_ACTIONS + 2; action += 1) {
      expect(await admit(async () => await Promise.resolve("ran"))).toEqual(
        Result.ok("ran"),
      );
    }
    expect(redis.periodAcquisitions()).toBe(0);
  });

  test("inside an admitted action of the same member it joins that action", async () => {
    const redis = countingRedis();
    const admit = freeAdmission({
      modelCredentials: ORGANIZATION_MODEL_CREDENTIALS.managed,
      redis,
    });
    const outer = await admit({
      organizationId,
      userId,
      organizationStateDb: createScopedDbMock({}).scopedDb,
      periodIdentity: {
        actionKind: "mcp.services/call",
        logicalPhaseId: "tool-call",
      },
      run: async () =>
        await admitterFor({ actionKind: "templates.fill", admit })(
          async ({ admission }) => await Promise.resolve(admission.actionKind),
        ),
    });
    expect(outer).toEqual(Result.ok(Result.ok("templates.fill")));
    expect(redis.periodAcquisitions()).toBe(1);
  });

  test("an unavailable admission answers as unavailable, never as a refusal", () => {
    expect(modelActionRefusal(new Error("coordination down"))).toMatchObject({
      status: 503,
      code: "service_unavailable",
    });
  });
});

describe("model actions that continue after their caller answers", () => {
  // Counts the slots an admission holds, as the lease set does.
  const slotAdmission = () => {
    const slots = { held: 0, scopes: [] as (string | undefined)[] };
    const released = Promise.withResolvers<undefined>();
    const admit: typeof withActionAdmission = async ({ run, scope }) => {
      slots.scopes.push(scope);
      slots.held += 1;
      try {
        return Result.ok(
          await run(new AbortController().signal, {
            reservePeriod: async () => Result.ok(undefined),
          }),
        );
      } catch (error) {
        return Result.err(error);
      } finally {
        slots.held -= 1;
        released.resolve(undefined);
      }
    };
    return { slots, released: released.promise, admit };
  };

  test("a blocked generation keeps its slot after the caller answers, until it settles", async () => {
    const { slots, released, admit } = slotAdmission();
    const generation = Promise.withResolvers<undefined>();
    const proofs: ModelDispatchAdmission[] = [];
    const answered = await createDetachedModelActionStarter({
      organizationId,
      userId,
      organizationStateDb: createScopedDbMock({}).scopedDb,
      actionKind: "case-law.analysis",
      admit,
    })({
      label: "test.generation",
      start: async () => await Promise.resolve("generating"),
      background: async ({ admission }) => {
        proofs.push(admission);
        await generation.promise;
      },
    });

    expect(answered).toEqual(Result.ok("generating"));
    expect(slots.held).toBe(1);
    expect(proofs.at(0)?.signal.aborted).toBe(false);
    // Detached work never joins the caller's admission, which settles first.
    expect(slots.scopes).toEqual(["independent"]);
    generation.resolve(undefined);
    await released;
    expect(slots.held).toBe(0);
    expect(proofs.at(0)?.signal.aborted).toBe(true);
  });

  test("a refusal reaches the caller and starts nothing", async () => {
    const refusal = new Error("busy");
    let ran = false;
    const answered = await createDetachedModelActionStarter({
      organizationId,
      userId,
      organizationStateDb: createScopedDbMock({}).scopedDb,
      actionKind: "case-law.analysis",
      admit: async () => await Promise.resolve(Result.err(refusal)),
    })({
      label: "test.generation",
      start: async () => {
        ran = true;
        return await Promise.resolve("generating");
      },
      background: async () => {
        ran = true;
        await Promise.resolve();
      },
    });
    expect(answered).toEqual(Result.err(refusal));
    expect(ran).toBe(false);
  });
});

describe("scheduled background work", () => {
  test("takes a background slot and hands its run the background proof", async () => {
    const redis = countingRedis();
    const outcome = await runScheduledBackgroundWork({
      organizationStateDb: testOrganizationStateDb,
      actionKind: "chat.background",
      organizationId,
      userId,
      admission: freeAdmission({
        modelCredentials: ORGANIZATION_MODEL_CREDENTIALS.managed,
        redis,
      }),
      run: async (signal, admission) =>
        await Promise.resolve({ aborted: signal.aborted, admission }),
    });
    expect(outcome).toEqual(
      Result.ok({
        aborted: false,
        admission: expect.objectContaining({
          type: "organization",
          organizationId,
          actionKind: "chat.background",
        }),
      }),
    );
    // Its parent's sends drew the actions: the slot draws none.
    expect(redis.periodAcquisitions()).toBe(0);
  });
});
