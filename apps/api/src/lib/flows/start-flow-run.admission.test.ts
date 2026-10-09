import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { safeDbFromScoped } from "@/api/db/safe-db";
import type { flowDefinitions } from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import { startAutomatedFlowRun } from "@/api/lib/flows/start-automated-flow-run";
import { startFlowRun } from "@/api/lib/flows/start-flow-run";
import { ActionAdmissionError } from "@/api/lib/rate-limit/action-admission";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { NO_FEATURE_ACCESS_FACTS } from "@/api/tests/helpers/member-authorization";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const testState = createTestState({ file: import.meta.path, config: env });

const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();
const workspaceId = createSafeId<"workspace">();
const definitionId = createSafeId<"flowDefinition">();
const definition = {
  id: definitionId,
  name: "Review document",
  enabled: true,
  trigger: {
    type: "schedule" as const,
    workspaceId,
    schedule: { frequency: "daily" as const, hourUtc: 23 },
  },
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
  "id" | "name" | "enabled" | "createdByUserId" | "steps" | "trigger"
>;

const withAdmission = async (run: () => Promise<void>) => {
  const previous = env.FEATURE_ACTION_ADMISSION;
  testState.setConfig("FEATURE_ACTION_ADMISSION", true);
  try {
    await run();
  } finally {
    testState.setConfig("FEATURE_ACTION_ADMISSION", previous);
  }
};

describe("flow kickoff acceptance", () => {
  test("manual starts enqueue the committed run after a lease abort", async () => {
    await withAdmission(async () => {
      const lease = new AbortController();
      let insertedRows = 0;
      const queuedRunIds: string[] = [];
      const safeDb = safeDbFromScoped(async (run) => {
        const result = await run(
          asTestRaw({
            execute: async () => [{ key1: 1, key2: 1, acquired: true }],
            select: (projection: Record<string, unknown>) => {
              const chain = {
                from: () => chain,
                innerJoin: () => chain,
                where: () => chain,
                limit: async () =>
                  "email" in projection
                    ? [{ email: "flow@example.test", emailVerified: true }]
                    : [{ featureId: "flows", organizationId, userId }],
              };
              return chain;
            },
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
            expectedScheduleTrigger: definition.trigger,
            inputEntityIds: [],
            logContext: {},
          },
          {
            findDefinition: async () => definition,
            featureEnabled: async () => true,
            resolveAuthorization: async () => ({
              memberId: "member",
              email: "member@example.test",
              role: "owner",
              workspace: { id: workspaceId, status: "active" },
              ...NO_FEATURE_ACCESS_FACTS,
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
