import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { safeDbFromScoped } from "@/api/db/safe-db";
import type { flowDefinitions } from "@/api/db/schema";
import { env } from "@/api/env";
import { authorizeHandlerRunSize } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import { startAutomatedFlowRun } from "@/api/lib/flows/start-automated-flow-run";
import { startFlowRun } from "@/api/lib/flows/start-flow-run";
import { ActionAdmissionError } from "@/api/lib/rate-limit/action-admission";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { PLAIN_MEMBER_FACTS } from "@/api/tests/helpers/member-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();
const workspaceId = createSafeId<"workspace">();
const definitionId = createSafeId<"flowDefinition">();
const definition = {
  id: definitionId,
  name: "Review document",
  enabled: true,
  createdByUserId: userId,
  steps: [
    {
      kind: "review-gate",
      name: "Review",
      instructions: "Review the document.",
    },
  ],
} satisfies Pick<
  typeof flowDefinitions.$inferSelect,
  "id" | "name" | "enabled" | "createdByUserId" | "steps"
>;

const withAdmission = async (run: () => Promise<void>) => {
  const previous = env.FEATURE_ACTION_ADMISSION;
  env.FEATURE_ACTION_ADMISSION = true;
  try {
    await run();
  } finally {
    env.FEATURE_ACTION_ADMISSION = previous;
  }
};

describe("flow kickoff acceptance", () => {
  test("pending automated admission retains its definition and execution input", async () => {
    const entered = Promise.withResolvers<undefined>();
    const proceed = Promise.withResolvers<undefined>();
    const loadedDefinition = {
      ...definition,
      steps: definition.steps.map((step) => ({ ...step })),
    };
    const originalInput = createSafeId<"entity">();
    const inputEntityIds = [originalInput];
    const written: unknown[] = [];
    const result = startAutomatedFlowRun(
      {
        definitionId,
        organizationId,
        workspaceId,
        createdByUserId: userId,
        triggerSource: { type: "schedule" },
        inputEntityIds,
        logContext: {},
      },
      {
        findDefinition: async () => loadedDefinition,
        resolveAuthorization: async () => {
          entered.resolve(undefined);
          await proceed.promise;
          return {
            memberId: "member",
            email: "member@example.test",
            role: "owner",
            workspace: { id: workspaceId, status: "active" },
            ...NO_FEATURE_ACCESS_FACTS,
          };
        },
        insertWithinCap: async ({ rows }) => {
          written.push(rows.run, rows.steps);
          return { outcome: "started" };
        },
        enqueueStep: async () => await Promise.resolve(),
        kickoff: async ({ run }) =>
          await run(new AbortController().signal, async () => undefined),
      },
    );
    await entered.promise;
    inputEntityIds.push(createSafeId<"entity">());
    loadedDefinition.steps.push({
      kind: "review-gate",
      name: "Changed",
      instructions: "Changed instructions.",
    });
    proceed.resolve(undefined);
    await result;
    expect(written).toHaveLength(2);
    expect(written.at(0)).toMatchObject({ inputEntityIds: [originalInput] });
    expect(written.at(1)).toHaveLength(1);
  });

  test("pending flow admission retains its definition and execution input", async () => {
    const entered = Promise.withResolvers<undefined>();
    const proceed = Promise.withResolvers<undefined>();
    const loadedDefinition = {
      ...definition,
      steps: definition.steps.map((step) => ({ ...step })),
    };
    const written: unknown[] = [];
    const safeDb = safeDbFromScoped(
      async (run) =>
        await run(
          asTestRaw({
            query: {
              flowDefinitions: { findFirst: async () => loadedDefinition },
            },
            insert: () => ({
              values: async (rows: unknown) => {
                written.push(rows);
              },
            }),
          }),
        ),
    );
    const originalInput = createSafeId<"entity">();
    const inputEntityIds = [originalInput];
    const options = {
      admit: async () => {
        entered.resolve(undefined);
        await proceed.promise;
        return await authorizeHandlerRunSize({
          metering: null,
          orgAIConfig: null,
          organizationId,
          workspaceId,
          userId,
          safeDb,
          estimatedUnits: 0,
          confirmedUnits: undefined,
        });
      },
      safeDb,
      organizationId,
      workspaceId,
      definitionId,
      triggerSource: { type: "manual", userId },
      inputEntityIds,
      kickoff: async ({ run }) =>
        await run(new AbortController().signal, async () => undefined),
      enqueueStep: async () => await Promise.resolve(),
    } satisfies Parameters<typeof startFlowRun>[0];
    const result = startFlowRun(options);
    await entered.promise;
    inputEntityIds.push(createSafeId<"entity">());
    loadedDefinition.steps.push({
      kind: "review-gate",
      name: "Changed",
      instructions: "Changed instructions.",
    });
    options.triggerSource.userId = mintAuthProviderId<"user">();
    proceed.resolve(undefined);
    expect(Result.isOk(await result)).toBe(true);
    expect(written).toHaveLength(2);
    expect(written.at(0)).toMatchObject({
      inputEntityIds: [originalInput],
      triggerSource: { type: "manual", userId },
    });
    expect(written.at(1)).toHaveLength(1);
  });

  test("manual starts enqueue the committed run after a lease abort", async () => {
    await withAdmission(async () => {
      const lease = new AbortController();
      let insertedRows = 0;
      const queuedRunIds: string[] = [];
      const safeDb = safeDbFromScoped(async (run) => {
        const result = await run(
          asTestRaw({
            query: { flowDefinitions: { findFirst: async () => definition } },
            insert: () => ({
              values: async () => {
                insertedRows += 1;
              },
            }),
          }),
        );
        if (insertedRows > 0) {
          lease.abort(
            new ActionAdmissionError({
              message: "Lease lost at commit",
              reason: "unavailable",
            }),
          );
        }
        return result;
      });
      const result = await startFlowRun({
        admit: async () =>
          await authorizeHandlerRunSize({
            metering: null,
            orgAIConfig: null,
            organizationId,
            workspaceId,
            userId,
            safeDb,
            estimatedUnits: 0,
            confirmedUnits: undefined,
          }),
        safeDb,
        organizationId,
        workspaceId,
        definitionId,
        triggerSource: { type: "manual", userId },
        inputEntityIds: [],
        kickoff: async ({ run }) =>
          await run(lease.signal, async () => undefined),
        enqueueStep: async ({ runId }) => {
          queuedRunIds.push(runId);
        },
      });
      expect(lease.signal.aborted).toBe(true);
      expect(insertedRows).toBe(2);
      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value.status).toBe("pending");
        expect(queuedRunIds).toEqual([result.value.runId]);
      }
    });
  });

  test("manual admission refusals retain their original typed error and write nothing", async () => {
    await withAdmission(async () => {
      for (const reason of ["busy", "unavailable"] as const) {
        let inserted = false;
        let enqueued = false;
        const error = new ActionAdmissionError({
          message: "Admission refused",
          reason,
        });
        const safeDb = safeDbFromScoped(
          async (run) =>
            await run(
              asTestRaw({
                query: {
                  flowDefinitions: { findFirst: async () => definition },
                },
                insert: () => ({
                  values: async () => {
                    inserted = true;
                  },
                }),
              }),
            ),
        );
        const result = await startFlowRun({
          admit: async () =>
            await authorizeHandlerRunSize({
              metering: null,
              orgAIConfig: null,
              organizationId,
              workspaceId,
              userId,
              safeDb,
              estimatedUnits: 0,
              confirmedUnits: undefined,
            }),
          safeDb,
          organizationId,
          workspaceId,
          definitionId,
          triggerSource: { type: "manual", userId },
          inputEntityIds: [],
          kickoff: async () => {
            throw error;
          },
          enqueueStep: async () => {
            enqueued = true;
          },
        });
        expect(result).toEqual(Result.err(error));
        expect(inserted).toBe(false);
        expect(enqueued).toBe(false);
      }
    });
  });

  test("an abort before manual insertion creates and enqueues nothing", async () => {
    await withAdmission(async () => {
      const lease = new AbortController();
      let inserted = false;
      let enqueued = false;
      const safeDb = safeDbFromScoped(
        async (run) =>
          await run(
            asTestRaw({
              query: { flowDefinitions: { findFirst: async () => definition } },
              insert: () => ({
                values: async () => {
                  inserted = true;
                },
              }),
            }),
          ),
      );
      const result = await startFlowRun({
        admit: async () =>
          await authorizeHandlerRunSize({
            metering: null,
            orgAIConfig: null,
            organizationId,
            workspaceId,
            userId,
            safeDb,
            estimatedUnits: 0,
            confirmedUnits: undefined,
          }),
        safeDb,
        organizationId,
        workspaceId,
        definitionId,
        triggerSource: { type: "manual", userId },
        inputEntityIds: [],
        kickoff: async ({ run }) => {
          lease.abort(
            new ActionAdmissionError({
              message: "Lease lost before insertion",
              reason: "unavailable",
            }),
          );
          return await run(lease.signal, async () => undefined);
        },
        enqueueStep: async () => {
          enqueued = true;
        },
      });
      expect(Result.isError(result)).toBe(true);
      expect(inserted).toBe(false);
      expect(enqueued).toBe(false);
    });
  });

  test("automated starts enqueue after commit aborts but never before acceptance", async () => {
    await withAdmission(async () => {
      for (const abortAt of ["before-insert", "commit"] as const) {
        const lease = new AbortController();
        let inserted = false;
        const queuedRunIds: string[] = [];
        let committedRunId: string | undefined;
        await startAutomatedFlowRun(
          {
            organizationId,
            workspaceId,
            definitionId,
            createdByUserId: userId,
            triggerSource: { type: "schedule" },
            inputEntityIds: [],
            logContext: {},
          },
          {
            findDefinition: async () => definition,
            resolveAuthorization: async () => ({
              memberId: "member",
              email: "member@example.test",
              role: "owner",
              workspace: { id: workspaceId, status: "active" },
              ...PLAIN_MEMBER_FACTS,
            }),
            insertWithinCap: async ({ rows }) => {
              inserted = true;
              committedRunId = rows.run.id;
              lease.abort(
                new ActionAdmissionError({
                  message: "Lease lost at commit",
                  reason: "unavailable",
                }),
              );
              return { outcome: "started" };
            },
            enqueueStep: async ({ runId }) => {
              queuedRunIds.push(runId);
            },
            kickoff: async ({ run }) => {
              if (abortAt === "before-insert") {
                lease.abort(
                  new ActionAdmissionError({
                    message: "Lease lost before insertion",
                    reason: "unavailable",
                  }),
                );
              }
              return await run(lease.signal, async () => undefined);
            },
          },
        );
        expect(inserted).toBe(abortAt === "commit");
        expect(queuedRunIds).toHaveLength(abortAt === "commit" ? 1 : 0);
        expect(queuedRunIds.at(0)).toBe(committedRunId);
      }
    });
  });
});
