import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  auditLogs,
  documentTypes,
  playbookDefinitions,
  properties,
  propertyDependencies,
  workspaces,
} from "@/api/db/schema";
import {
  setSharedLockTimeout,
  setSharedStatementTimeout,
} from "@/api/db/shared-pool-timeouts";
import deleteDocumentType from "@/api/handlers/document-types/delete";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { materializePlaybookRun } from "@/api/lib/workflow/materialize-playbook-run";
import type { PlaybookPositions } from "@/api/lib/workflow/playbook-positions";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { testModelActionAdmitter } from "@/api/tests/helpers/model-dispatch-admission";

import { DOCUMENT_TYPE_NOT_FOUND_MESSAGE } from "./assert-document-type";
import { createPlaybookDefinitionHandler } from "./create-shared";
import { updatePlaybookDefinitionHandler } from "./update-shared";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const noopAuditRecorder: AuditRecorder = async () => undefined;
const playbookName = "Scoped reference";

const createBarrier = () => {
  const reached = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  let state: "waiting" | "holding" | "released" = "waiting";
  return {
    reached: reached.promise,
    isWaiting: () => state === "waiting",
    hold: async () => {
      state = "holding";
      reached.resolve(undefined);
      await released.promise;
    },
    release: () => {
      state = "released";
      released.resolve(undefined);
    },
  };
};

// Execute the real successful taxonomy read, then suspend its await before
// the handler can write. No lock or query is added by the instrumentation.
const holdDocumentTypeCheck = (
  tx: Transaction,
  barrier: ReturnType<typeof createBarrier>,
) =>
  new Proxy(tx, {
    get(target, key, receiver) {
      if (key !== "query") {
        return Reflect.get(target, key, receiver);
      }
      return new Proxy(target.query, {
        get(queryTarget, tableKey, queryReceiver) {
          if (tableKey !== "documentTypes") {
            return Reflect.get(queryTarget, tableKey, queryReceiver);
          }
          return new Proxy(queryTarget.documentTypes, {
            get(tableTarget, method, tableReceiver) {
              if (method !== "findFirst") {
                return Reflect.get(tableTarget, method, tableReceiver);
              }
              return (config: Parameters<typeof tableTarget.findFirst>[0]) => {
                const query = tableTarget.findFirst(config);
                const execute = query.execute.bind(query);
                query.execute = async (values) => {
                  const result = await execute(values);
                  expect(result).toBeDefined();
                  await barrier.hold();
                  return result;
                };
                return query;
              };
            },
          });
        },
      });
    },
  });

// The delete's friendly reference check must observe no committed scope.
// Delaying its real SELECT lets both checks succeed before either write.
const holdDeleteReferenceCheck = (
  tx: Transaction,
  barrier: ReturnType<typeof createBarrier>,
) =>
  new Proxy(tx, {
    get(target, key, receiver) {
      if (key !== "select") {
        return Reflect.get(target, key, receiver);
      }
      return (fields: Parameters<typeof target.select>[0]) => {
        const builder = target.select(fields);
        return new Proxy(builder, {
          get(builderTarget, method, builderReceiver) {
            if (method !== "from") {
              return Reflect.get(builderTarget, method, builderReceiver);
            }
            return (table: Parameters<typeof builderTarget.from>[0]) => {
              const query = builderTarget.from(table);
              const execute = query.execute.bind(query);
              query.execute = async (values) => {
                const result = await execute(values);
                if (table === playbookDefinitions && barrier.isWaiting()) {
                  expect(result).toEqual([]);
                  await barrier.hold();
                }
                return result;
              };
              return query;
            };
          },
        });
      };
    },
  });

const createSafeTestDb = (
  db: GatedTestDb,
  instrument: (tx: Transaction) => Transaction = (tx) => tx,
) =>
  safeDbFromScoped(
    async (run) =>
      await db.transaction(async (tx) => {
        await setSharedLockTimeout(tx, 5000);
        await setSharedStatementTimeout(tx, 10_000);
        return await run(instrument(tx));
      }),
  );

const seedFixture = async (db: GatedTestDb) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const documentTypeId = createSafeId<"documentType">();
  const classifierId = createSafeId<"property">();
  const positions = {
    version: 3,
    items: [
      {
        mode: "extract",
        sourceId: createSafeId<"property">(),
        issue: "Reference value",
        enabled: true,
        ask: { question: "", content: { version: 1, type: "text" } },
      },
    ],
  } as const satisfies PlaybookPositions;
  const key = "reference-agreement";
  const label = "Reference agreement";
  await db.insert(organization).values({
    id: organizationId,
    name: "Reference test organization",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Reference test matter",
    reference: workspaceId,
  });
  await db.insert(documentTypes).values({
    id: documentTypeId,
    organizationId,
    key,
    label,
  });
  await db.insert(properties).values([
    {
      id: createSafeId<"property">(),
      workspaceId,
      name: "File",
      status: "fresh",
      system: true,
      content: { version: 1, type: "file" },
      tool: { version: 1, type: "manual-input" },
    },
    {
      id: classifierId,
      workspaceId,
      name: "Document Type",
      status: "fresh",
      role: "document-type-classifier",
      content: {
        version: 1,
        type: "single-select",
        options: [{ value: label, color: "blue" }],
        fallback: null,
      },
      tool: { version: 1, type: "ai-model", prompt: "Classify the document" },
    },
  ]);
  return {
    organizationId,
    userId,
    workspaceId,
    documentTypeId,
    classifierId,
    positions,
    key,
    label,
  };
};

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

type ExpectWinnerAuditOptions = {
  db: GatedTestDb;
  fixture: Fixture;
  event: AuditEvent;
};

const expectWinnerAudit = async ({
  db,
  fixture,
  event,
}: ExpectWinnerAuditOptions) => {
  const events = await db
    .select({
      action: auditLogs.action,
      resourceType: auditLogs.resourceType,
      resourceId: auditLogs.resourceId,
      changes: auditLogs.changes,
      organizationId: auditLogs.organizationId,
      workspaceId: auditLogs.workspaceId,
      userId: auditLogs.userId,
      performerType: auditLogs.performerType,
      performerId: auditLogs.performerId,
      triggerType: auditLogs.triggerType,
      approvalStatus: auditLogs.approvalStatus,
    })
    .from(auditLogs)
    .where(eq(auditLogs.organizationId, fixture.organizationId));
  expect(events).toEqual([
    {
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      changes: event.changes ?? null,
      organizationId: fixture.organizationId,
      workspaceId: null,
      userId: fixture.userId,
      performerType: "user",
      performerId: fixture.userId,
      triggerType: "direct",
      approvalStatus: "not_required",
    },
  ]);
};

const expectPersistedScopesMaterialize = async (
  db: GatedTestDb,
  fixture: Fixture,
) => {
  const definitions = await db.query.playbookDefinitions.findMany({
    where: { organizationId: { eq: fixture.organizationId } },
  });
  for (const definition of definitions) {
    expect(definition.positions.items.length).toBeGreaterThan(0);
    const result = await db.transaction(
      async (tx) =>
        await materializePlaybookRun({
          tx,
          workspaceId: fixture.workspaceId,
          organizationId: fixture.organizationId,
          playbookId: definition.id,
          positions: definition.positions.items,
          scope: definition.scope,
          recordAuditEvent: noopAuditRecorder,
        }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      panic(result.message);
    }
    expect(result.materializedPropertyIds).toHaveLength(1);
    if (definition.scope?.documentTypeKey) {
      const dependencies = await db
        .select()
        .from(propertyDependencies)
        .where(eq(propertyDependencies.workspaceId, fixture.workspaceId));
      expect(dependencies).toContainEqual(
        expect.objectContaining({
          dependsOnPropertyId: fixture.classifierId,
          condition: {
            type: "compare",
            left: { type: "property", propertyId: fixture.classifierId },
            op: "eq",
            right: { type: "literal", value: fixture.label },
          },
        }),
      );
    }
  }
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("playbook document type references on Postgres", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("playbook document type references on Postgres", () => {
    for (const operation of ["create", "update"] as const) {
      for (const firstCommit of ["save", "delete"] as const) {
        test(`${operation} and delete preserve a resolvable scope when ${firstCommit} commits first`, async () => {
          await withGatedTestClients(databaseUrl, async ({ openClient }) => {
            const saveDb = openClient().db;
            const deleteDb = openClient().db;
            const fixture = await seedFixture(saveDb);
            const saveBarrier = createBarrier();
            const deleteBarrier = createBarrier();
            const tasks: Promise<unknown>[] = [];
            try {
              const recordAuditEvent = createAuditRecorder({
                organizationId: fixture.organizationId,
                workspaceId: null,
                userId: fixture.userId,
                request: new Request("https://example.test/playbooks"),
                server: null,
              });
              const writeContext = {
                admitModelAction: testModelActionAdmitter(
                  fixture.organizationId,
                ),
                organizationId: fixture.organizationId,
                accessibleWorkspaceIds: [],
                orgAIConfig: null,
                orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
                managedAIResidency: "eu" as const,
                promptCachingEnabled: false,
                recordAuditEvent,
              };
              const playbookId = createSafeId<"playbookDefinition">();
              if (operation === "update") {
                await saveDb.insert(playbookDefinitions).values({
                  id: playbookId,
                  organizationId: fixture.organizationId,
                  name: "Original unscoped definition",
                  positions: fixture.positions,
                });
              }
              const original = await saveDb.query.playbookDefinitions.findFirst(
                {
                  where: { id: { eq: playbookId } },
                },
              );
              const safeDb = createSafeTestDb(saveDb, (tx) =>
                holdDocumentTypeCheck(tx, saveBarrier),
              );
              const body = {
                name: playbookName,
                positions: fixture.positions,
                scope: { documentTypeKey: fixture.key },
              };
              const save =
                operation === "create"
                  ? Result.gen(async function* () {
                      return yield* createPlaybookDefinitionHandler({
                        ...writeContext,
                        safeDb,
                        body,
                        origin: { type: "authored" },
                      });
                    })
                  : Result.gen(async function* () {
                      return yield* updatePlaybookDefinitionHandler({
                        ...writeContext,
                        safeDb,
                        body,
                        playbookId,
                      });
                    }).then((result) => result.map(() => ({ id: playbookId })));
              tasks.push(save);
              await Promise.race([
                saveBarrier.reached,
                save.then((result) =>
                  panic(
                    result.isErr()
                      ? `Save failed before the type check barrier: ${result.error.message}`
                      : "Save finished before the type check barrier",
                  ),
                ),
              ]);
              type DeleteContext = Parameters<
                typeof deleteDocumentType.handler
              >[0];
              const deletion = deleteDocumentType.handler(
                createTestHandlerContext<DeleteContext>({
                  scopedDb: NO_DB,
                  session: { activeOrganizationId: fixture.organizationId },
                  user: { id: fixture.userId },
                  params: { documentTypeId: fixture.documentTypeId },
                  safeDb: createSafeTestDb(deleteDb, (tx) =>
                    holdDeleteReferenceCheck(tx, deleteBarrier),
                  ),
                  audit: recordAuditEvent,
                }),
              );
              tasks.push(deletion);
              await Promise.race([
                deleteBarrier.reached,
                deletion.then((result) =>
                  panic(
                    `Delete finished before the reference barrier: ${JSON.stringify(result)}`,
                  ),
                ),
              ]);

              if (firstCommit === "delete") {
                deleteBarrier.release();
                expect(await deletion).toEqual({});
                saveBarrier.release();
                const result = await save;
                expect(result.isErr()).toBe(true);
                if (result.isOk()) {
                  panic("A save must refuse the deleted document type");
                }
                expect(result.error).toMatchObject({
                  status: 400,
                  message: DOCUMENT_TYPE_NOT_FOUND_MESSAGE,
                  retryable: false,
                });
                const definitions =
                  await saveDb.query.playbookDefinitions.findMany({
                    where: { organizationId: { eq: fixture.organizationId } },
                  });
                expect(definitions).toEqual(original ? [original] : []);
                await expectWinnerAudit({
                  db: saveDb,
                  fixture,
                  event: {
                    action: AUDIT_ACTION.DELETE,
                    resourceType: AUDIT_RESOURCE_TYPE.DOCUMENT_TYPE,
                    resourceId: fixture.documentTypeId,
                    changes: {
                      deleted: {
                        old: { key: fixture.key, label: fixture.label },
                        new: null,
                      },
                    },
                  },
                });
              } else {
                saveBarrier.release();
                const result = await save;
                expect(result.isOk()).toBe(true);
                if (result.isErr()) {
                  panic(`Scoped save failed: ${result.error.message}`);
                }
                deleteBarrier.release();
                expect(await deletion).toMatchObject({
                  code: 409,
                  response: {
                    message: `In use by 1 playbook(s): ${playbookName}. Reassign them first.`,
                  },
                });
                const definitions =
                  await saveDb.query.playbookDefinitions.findMany({
                    where: { organizationId: { eq: fixture.organizationId } },
                  });
                expect(definitions).toHaveLength(1);
                expect(definitions.at(0)).toMatchObject({
                  name: playbookName,
                  scope: body.scope,
                });
                await expectWinnerAudit({
                  db: saveDb,
                  fixture,
                  event: {
                    action:
                      operation === "create"
                        ? AUDIT_ACTION.CREATE
                        : AUDIT_ACTION.UPDATE,
                    resourceType: AUDIT_RESOURCE_TYPE.PLAYBOOK,
                    resourceId: result.value.id,
                    changes:
                      operation === "create"
                        ? {
                            created: {
                              old: null,
                              new: { name: playbookName, positionCount: 1 },
                            },
                          }
                        : {
                            fields: {
                              old: null,
                              new: [
                                "name",
                                "description",
                                "scope",
                                "positions",
                                "status",
                              ],
                            },
                          },
                  },
                });
              }
              const remainingType = await saveDb.query.documentTypes.findFirst({
                where: { id: { eq: fixture.documentTypeId } },
              });
              expect(remainingType !== undefined).toBe(firstCommit === "save");
              await expectPersistedScopesMaterialize(saveDb, fixture);
            } finally {
              saveBarrier.release();
              deleteBarrier.release();
              try {
                await Promise.all(tasks);
              } finally {
                await saveDb
                  .delete(propertyDependencies)
                  .where(
                    eq(propertyDependencies.workspaceId, fixture.workspaceId),
                  );
                await saveDb
                  .delete(organization)
                  .where(eq(organization.id, fixture.organizationId));
              }
            }
          });
        }, 20_000);
      }
    }
  });
}
