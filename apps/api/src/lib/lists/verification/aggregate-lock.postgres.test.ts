import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  entities,
  legalListVerificationRuns,
  workspaces,
  workspaceMembers,
} from "@/api/db/schema";
import { markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import {
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import {
  completeVerificationRun,
  failVerificationRun,
} from "@/api/lib/lists/verification/run-persistence";
import {
  processListVerificationRun,
  resolveListVerificationRunAccess,
} from "@/api/lib/lists/verification/run-queue";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import { brandPersistedListVerificationRunId } from "@/api/lib/safe-id-boundaries";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { organizationFeatureGrants } from "@/api/tests/helpers/feature-grants";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { createTestState } from "@/api/tests/helpers/test-state";
import { withInterleaving } from "@/api/tests/helpers/transaction-interleaving";

const testState = createTestState({ file: import.meta.path, config: env });
const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("verification lifecycle aggregate locks (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  type VerificationFixture = {
    databaseUrl: string;
    db: GatedTestDb;
    workspaceId: SafeId<"workspace">;
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
    runId: SafeId<"legalListVerificationRun">;
    readStatus: () => Promise<string | undefined>;
  };

  const withFixture = async (
    run: (fixture: VerificationFixture) => Promise<void>,
  ) => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const entityId = createSafeId<"entity">();
      const runId = createSafeId<"legalListVerificationRun">();
      try {
        await db.insert(organization).values({
          id: organizationId,
          name: "Verification locks",
          slug: organizationId,
          createdAt: new Date(),
        });
        await db.insert(user).values({
          id: userId,
          name: "Reviewer",
          email: `${userId}@example.test`,
          emailVerified: true,
        });
        await db.insert(member).values({
          id: Bun.randomUUIDv7(),
          organizationId,
          userId,
          role: "member",
          createdAt: new Date(),
        });
        await db.insert(workspaces).values({
          id: workspaceId,
          organizationId,
          name: "Verification locks",
          reference: workspaceId,
        });
        await db.insert(workspaceMembers).values({
          id: createSafeId<"workspaceMember">(),
          workspaceId,
          userId,
        });
        await db
          .insert(entities)
          .values({ id: entityId, workspaceId, name: "Verification source" });
        await db.insert(legalListVerificationRuns).values({
          id: runId,
          organizationId,
          workspaceId,
          entityId,
          requestedBy: userId,
          fileFieldId: createSafeId<"field">(),
          entityVersionId: createSafeId<"entityVersion">(),
          contentSha256: "a".repeat(64),
          evidence: { listId: createSafeId<"legalList">(), facts: [] },
          status: "queued",
          pipelineVersion: 2,
        });
        testState.setConfig(
          "API_FEATURE_ACCESS_GRANTS",
          organizationFeatureGrants(organizationId, [
            "legal-lists",
            "list-verification",
          ]),
        );
        await run({
          databaseUrl,
          db,
          workspaceId,
          organizationId,
          userId,
          runId,
          readStatus: async () =>
            (
              await db
                .select({ status: legalListVerificationRuns.status })
                .from(legalListVerificationRuns)
                .where(eq(legalListVerificationRuns.id, runId))
            ).at(0)?.status,
        });
      } finally {
        await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await db.delete(user).where(eq(user.id, userId));
      }
    });
  };

  test("completion waits for the run writer and preserves the running predicate", async () => {
    await withFixture(
      async ({ databaseUrl: pgUrl, db, workspaceId, runId, readStatus }) => {
        await db
          .update(legalListVerificationRuns)
          .set({ status: "running" })
          .where(eq(legalListVerificationRuns.id, runId));
        await withInterleaving({
          databaseUrl: pgUrl,
          schedules: [["a.failed", "b.complete", "a.commit", "b.commit"]],
          a: {
            steps: [
              {
                name: "failed",
                run: async (tx) => {
                  await withAggregateLock({
                    tx,
                    aggregate: "listVerificationRun",
                    id: { id: runId, workspaceId },
                    mode: "update",
                  });
                  await tx
                    .update(legalListVerificationRuns)
                    .set({ status: "failed", errorCode: "internal" })
                    .where(eq(legalListVerificationRuns.id, runId));
                },
              },
            ],
          },
          b: {
            steps: [
              {
                name: "complete",
                run: async (tx) => {
                  await completeVerificationRun({
                    tx,
                    runId,
                    workspaceId,
                    blocks: [],
                    claims: [],
                  });
                },
              },
            ],
          },
          reset: async () => {},
          readState: readStatus,
          invariant: ({ blocked, outcomes, state }) => {
            expect(blocked).toContain("b.complete");
            expect(outcomes.a.status).toBe("committed");
            expect(outcomes.b.status).toBe("committed");
            expect(state).toBe("failed");
          },
        });
      },
    );
  });

  test("failure waits for the run writer before closing the active slot", async () => {
    await withFixture(
      async ({
        databaseUrl: pgUrl,
        workspaceId,
        organizationId,
        runId,
        readStatus,
      }) => {
        await withInterleaving({
          databaseUrl: pgUrl,
          schedules: [["a.lock", "b.fail", "a.commit", "b.commit"]],
          a: {
            steps: [
              {
                name: "lock",
                run: async (tx) =>
                  await withAggregateLock({
                    tx,
                    aggregate: "listVerificationRun",
                    id: { id: runId, workspaceId },
                    mode: "update",
                  }),
              },
            ],
          },
          b: {
            steps: [
              {
                name: "fail",
                run: async (tx) =>
                  expect(
                    await failVerificationRun({
                      tx,
                      run: { id: runId, workspaceId, organizationId },
                      errorCode: "internal",
                    }),
                  ).toBe(true),
              },
            ],
          },
          reset: async () => {},
          readState: readStatus,
          invariant: ({ blocked, outcomes, state }) => {
            expect(blocked).toContain("b.fail");
            expect(outcomes.b.status).toBe("committed");
            expect(state).toBe("failed");
          },
        });
      },
    );
  });

  test("access recheck and failure reacquire the same run after its writer commits", async () => {
    await withFixture(
      async ({
        databaseUrl: pgUrl,
        workspaceId,
        organizationId,
        runId,
        readStatus,
      }) => {
        await withInterleaving({
          databaseUrl: pgUrl,
          schedules: [["a.lock", "b.reconcile", "a.commit", "b.commit"]],
          a: {
            steps: [
              {
                name: "lock",
                run: async (tx) =>
                  await withAggregateLock({
                    tx,
                    aggregate: "listVerificationRun",
                    id: { id: runId, workspaceId },
                    mode: "update",
                  }),
              },
            ],
          },
          b: {
            steps: [
              {
                name: "reconcile",
                run: async (tx) => {
                  const run = { id: runId, workspaceId, organizationId };
                  expect(
                    await resolveListVerificationRunAccess({
                      tx,
                      run,
                      grants: {},
                    }),
                  ).toEqual({ status: "unavailable" });
                  expect(
                    await failVerificationRun({
                      tx,
                      run,
                      errorCode: "access_revoked",
                      expectedStatus: "queued",
                    }),
                  ).toBe(true);
                },
              },
            ],
          },
          reset: async () => {},
          readState: readStatus,
          invariant: ({ blocked, outcomes, state }) => {
            expect(blocked).toContain("b.reconcile");
            expect(outcomes.b.status).toBe("committed");
            expect(state).toBe("failed");
          },
        });
      },
    );
  });

  test("access-gated completion waits and reacquires the running row before persisting results", async () => {
    await withFixture(
      async ({
        databaseUrl: pgUrl,
        workspaceId,
        organizationId,
        userId,
        runId,
        readStatus,
      }) => {
        const restoreMode = setRuntimeModeForTesting({
          mode: RUNTIME_MODE.strict,
        });
        testState.setConfig("FEATURE_LEGAL_LISTS", true);
        try {
          await withInterleaving({
            databaseUrl: pgUrl,
            schedules: [["a.running", "b.complete", "a.commit", "b.commit"]],
            a: {
              steps: [
                {
                  name: "running",
                  run: async (tx) => {
                    await withAggregateLock({
                      tx,
                      aggregate: "listVerificationRun",
                      id: { id: runId, workspaceId },
                      mode: "update",
                    });
                    await tx
                      .update(legalListVerificationRuns)
                      .set({ status: "running" })
                      .where(eq(legalListVerificationRuns.id, runId));
                  },
                },
              ],
            },
            b: {
              steps: [
                {
                  name: "complete",
                  run: async (tx) => {
                    const access = await resolveListVerificationRunAccess({
                      tx,
                      run: { id: runId, workspaceId, organizationId },
                      requesterId: userId,
                      expectedStatus: "running",
                      grants: {
                        [LEGAL_LISTS_FEATURE_ID]: [
                          { type: "organization", organizationId },
                        ],
                        [LIST_VERIFICATION_FEATURE_ID]: [
                          { type: "organization", organizationId },
                        ],
                      },
                    });
                    expect(access.status).toBe("available");
                    await completeVerificationRun({
                      tx,
                      runId,
                      workspaceId,
                      blocks: [],
                      claims: [],
                    });
                  },
                },
              ],
            },
            reset: async () => {},
            readState: readStatus,
            invariant: ({ blocked, outcomes, state, sessions }) => {
              expect(sessions.a.pid).not.toBe(sessions.b.pid);
              expect(blocked).toEqual(["b.complete"]);
              expect(outcomes.a.status).toBe("committed");
              expect(outcomes.b.status).toBe("committed");
              expect(state).toBe("completed");
            },
          });
        } finally {
          restoreMode();
        }
      },
    );
  });

  test("worker claim waits for the run before executing", async () => {
    await withFixture(
      async ({
        databaseUrl: pgUrl,
        workspaceId,
        organizationId,
        userId,
        runId,
        readStatus,
      }) => {
        let executionCalls = 0;
        const restoreMode = setRuntimeModeForTesting({
          mode: RUNTIME_MODE.strict,
        });
        testState.setConfig("FEATURE_LEGAL_LISTS", true);
        try {
          await withInterleaving({
            databaseUrl: pgUrl,
            schedules: [["a.lock", "b.worker", "a.commit", "b.commit"]],
            a: {
              steps: [
                {
                  name: "lock",
                  run: async (tx) =>
                    await withAggregateLock({
                      tx,
                      aggregate: "listVerificationRun",
                      id: { id: runId, workspaceId },
                      mode: "update",
                    }),
                },
              ],
            },
            b: {
              steps: [
                {
                  name: "worker",
                  run: async (tx) => {
                    const data = { runId, workspaceId, organizationId, userId };
                    const database = markRlsDatabase({
                      transaction: async <T>(
                        run: (transaction: Transaction) => Promise<T>,
                      ) => await run(tx),
                    });
                    await processListVerificationRun({
                      data,
                      actor: createRootRunActor(
                        data,
                        brandPersistedListVerificationRunId,
                        database,
                      ),
                      admission: testModelAdmission(organizationId),
                      grants: {
                        [LEGAL_LISTS_FEATURE_ID]: [
                          { type: "organization", organizationId },
                        ],
                        [LIST_VERIFICATION_FEATURE_ID]: [
                          { type: "organization", organizationId },
                        ],
                      },
                      execute: async () => {
                        executionCalls += 1;
                        return null;
                      },
                    });
                  },
                },
              ],
            },
            reset: async () => {},
            readState: readStatus,
            invariant: ({ blocked, outcomes, state }) => {
              expect(blocked).toContain("b.worker");
              expect(outcomes.b.status).toBe("committed");
              expect(state).toBe("running");
              expect(executionCalls).toBe(1);
            },
          });
        } finally {
          restoreMode();
        }
      },
    );
  });

  test("terminal worker failure waits after its claim commits and reacquires the authoritative requester", async () => {
    await withFixture(
      async ({
        databaseUrl: pgUrl,
        db,
        workspaceId,
        organizationId,
        userId,
        runId,
        readStatus,
      }) => {
        const restoreMode = setRuntimeModeForTesting({
          mode: RUNTIME_MODE.strict,
        });
        testState.setConfig("FEATURE_LEGAL_LISTS", true);
        let worker: ReturnType<typeof processListVerificationRun> | undefined;
        const started = Promise.withResolvers<undefined>();
        const finish = Promise.withResolvers<undefined>();
        try {
          await withInterleaving({
            databaseUrl: pgUrl,
            schedules: [
              ["b.claim", "a.lock", "b.fail", "a.commit", "b.commit"],
            ],
            a: {
              steps: [
                {
                  name: "lock",
                  run: async (tx) => {
                    expect(await readStatus()).toBe("running");
                    await withAggregateLock({
                      tx,
                      aggregate: "listVerificationRun",
                      id: { id: runId, workspaceId },
                      mode: "update",
                    });
                  },
                },
              ],
            },
            b: {
              steps: [
                {
                  name: "claim",
                  run: async (tx, signal) => {
                    const data = { runId, workspaceId, organizationId, userId };
                    let transactions = 0;
                    const database = markRlsDatabase({
                      transaction: async <T>(
                        run: (transaction: Transaction) => Promise<T>,
                      ) => {
                        transactions += 1;
                        if (transactions === 1) {
                          return await db.transaction(run);
                        }
                        return await run(tx);
                      },
                    });
                    worker = processListVerificationRun({
                      data,
                      actor: createRootRunActor(
                        data,
                        brandPersistedListVerificationRunId,
                        database,
                      ),
                      admission: testModelAdmission(organizationId),
                      grants: {
                        [LEGAL_LISTS_FEATURE_ID]: [
                          { type: "organization", organizationId },
                        ],
                        [LIST_VERIFICATION_FEATURE_ID]: [
                          { type: "organization", organizationId },
                        ],
                      },
                      execute: async () => {
                        started.resolve(undefined);
                        const cancel = () => finish.reject(signal.reason);
                        signal.addEventListener("abort", cancel, {
                          once: true,
                        });
                        try {
                          await finish.promise;
                        } finally {
                          signal.removeEventListener("abort", cancel);
                        }
                        return "internal";
                      },
                    });
                    await Promise.race([
                      started.promise,
                      worker.then(() =>
                        panic("Worker stopped before terminal barrier"),
                      ),
                    ]);
                  },
                },
                {
                  name: "fail",
                  run: async () => {
                    finish.resolve(undefined);
                    await (worker ?? panic("Worker claim was not started"));
                  },
                },
              ],
            },
            reset: async () => {},
            readState: readStatus,
            invariant: ({ blocked, outcomes, state }) => {
              expect(blocked).toContain("b.fail");
              expect(outcomes.b.status).toBe("committed");
              expect(state).toBe("failed");
            },
          });
        } finally {
          finish.resolve(undefined);
          try {
            await worker;
          } finally {
            restoreMode();
          }
        }
      },
    );
  });
}
