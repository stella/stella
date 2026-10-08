import { panic, Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import type { ScopedDb } from "@/api/db/safe-db";
import { featureEnrolments } from "@/api/db/schema";
import { env } from "@/api/env";
import { createRenameEntityHandler } from "@/api/handlers/entities/rename-operation";
import { deleteEntityVersionHandler } from "@/api/handlers/entities/versions/delete";
import { updateVersionDescriptionHandler } from "@/api/handlers/entities/versions/description/update";
import { updateVersionLabelHandler } from "@/api/handlers/entities/versions/label/update";
import restoreVersion from "@/api/handlers/entities/versions/restore";
import { createSafeId } from "@/api/lib/branded-types";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const databaseUrl = process.env["DATABASE_URL"];
const MUTATIONS = [
  "rename",
  "label",
  "description",
  "delete version",
  "restore version",
] as const;

// A missing version must not reveal its absence before the linked task's admission.
describe.skipIf(!enabled)(
  "linked task version mutation admission (postgres)",
  () => {
    for (const mutation of MUTATIONS) {
      for (const refusal of ["deployment disabled", "grant absent"] as const) {
        test(`${mutation}: ${refusal} refuses before version metadata or effects`, async () => {
          const restoreMode = setRuntimeModeForTesting({
            mode: RUNTIME_MODE.strict,
          });
          const previousFlag = env.FEATURE_FLOWS;
          env.FEATURE_FLOWS = refusal !== "deployment disabled";
          try {
            await withGatedTestClients(
              databaseUrl ?? panic("Missing PostgreSQL test URL"),
              async ({ openClient }) => {
                const client = openClient();
                const f = await flowReviewGateFixture(client.db, {
                  intermediate: false,
                });
                try {
                  if (refusal === "grant absent") {
                    await client.db
                      .delete(featureEnrolments)
                      .where(
                        and(
                          eq(
                            featureEnrolments.organizationId,
                            f.organizationId,
                          ),
                          eq(featureEnrolments.userId, f.userId),
                          eq(featureEnrolments.featureId, "flows"),
                        ),
                      );
                  }
                  const before = await f.read();
                  const recordAuditEvent = mock(async () => undefined);
                  const enqueue = mock(async () => undefined);
                  const flush = mock(async () => ({ failed: 0, repaired: 0 }));
                  const scopedDb: ScopedDb = async (work) => {
                    const result = await f.safeDb(client.db)(work);
                    if (result.isErr()) {
                      throw result.error;
                    }
                    return result.value;
                  };
                  const target = {
                    safeDb: f.safeDb(client.db),
                    workspaceId: f.workspaceId,
                    userId: f.userId,
                    entityId: f.taskEntityId,
                    versionId: createSafeId<"entityVersion">(),
                    recordAuditEvent,
                  };
                  const invoke = async () => {
                    switch (mutation) {
                      case "rename": {
                        const rename = createRenameEntityHandler({
                          enqueueEntitySearchRepairs: enqueue,
                          flushEntitySearchRepairs: flush,
                        });
                        return {
                          type: "result" as const,
                          response: await Result.gen(() =>
                            rename({
                              safeDb: target.safeDb,
                              workspaceId: target.workspaceId,
                              userId: target.userId,
                              recordAuditEvent,
                              body: {
                                entityId: target.entityId,
                                name: "Updated review",
                              },
                            }),
                          ),
                        };
                      }
                      case "label":
                        return {
                          type: "result" as const,
                          response: await Result.gen(() =>
                            updateVersionLabelHandler({
                              ...target,
                              label: "Updated label",
                            }),
                          ),
                        };
                      case "description":
                        return {
                          type: "result" as const,
                          response: await Result.gen(() =>
                            updateVersionDescriptionHandler({
                              ...target,
                              description: "Updated description",
                            }),
                          ),
                        };
                      case "delete version":
                        return {
                          type: "result" as const,
                          response: await Result.gen(() =>
                            deleteEntityVersionHandler({
                              safeDb: target.safeDb,
                              workspaceId: target.workspaceId,
                              entityId: target.entityId,
                              versionId: target.versionId,
                              deletedByUserId: target.userId,
                              recordAuditEvent,
                            }),
                          ),
                        };
                      case "restore version":
                        return {
                          type: "native" as const,
                          response: await restoreVersion.handler(
                            createTestHandlerContext<
                              Parameters<typeof restoreVersion.handler>[0]
                            >({
                              safeDb: target.safeDb,
                              scopedDb,
                              session: {
                                activeOrganizationId: f.organizationId,
                              },
                              workspaceId: target.workspaceId,
                              user: { id: target.userId },
                              recordAuditEvent,
                              params: {
                                workspaceId: target.workspaceId,
                                entityId: target.entityId,
                                versionId: target.versionId,
                              },
                            }),
                          ),
                        };
                      default:
                        mutation satisfies never;
                        return panic("Unknown task mutation");
                    }
                  };
                  const result = await invoke();
                  switch (result.type) {
                    case "native":
                      expect(result.response).toMatchObject({
                        code: 404,
                        response: { message: "Not found" },
                      });
                      break;
                    case "result":
                      expect(result.response.isErr()).toBe(true);
                      if (result.response.isOk()) {
                        return panic("Expected linked-task admission refusal");
                      }
                      expect(result.response.error).toMatchObject({
                        status: 404,
                        message: "Not found",
                      });
                      break;
                    default:
                      result satisfies never;
                  }
                  expect(await f.read()).toEqual(before);
                  expect(recordAuditEvent).not.toHaveBeenCalled();
                  expect(enqueue).not.toHaveBeenCalled();
                  expect(flush).not.toHaveBeenCalled();
                } finally {
                  await f.cleanup();
                }
              },
            );
          } finally {
            env.FEATURE_FLOWS = previousFlag;
            restoreMode();
          }
        });
      }
    }
  },
);
