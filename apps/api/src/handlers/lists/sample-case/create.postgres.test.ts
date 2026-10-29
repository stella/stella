import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";
import { MATTER_VISIBILITY } from "@stll/api-contract/matter-visibility";

import { member, organization, user } from "@/api/db/auth-schema";
import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  auditLogs,
  entities,
  legalListFactDetails,
  legalListItems,
  legalLists,
  pendingUploads,
  properties,
  workspaceMembers,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import { HttpStatusResponse } from "@/api/http/status";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { createSafeId } from "@/api/lib/branded-types";
import { lockMatterStewardship } from "@/api/lib/db/aggregate-lock";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import type { CreateEntityFromBufferDependencies } from "@/api/lib/entities/create-from-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import {
  FEATURE_REGISTRY,
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { OrganizationFileUsageError } from "@/api/lib/files/organization-file-usage";
import { enqueueEntitySearchRepairs } from "@/api/lib/search/projection-repair-queue";
import { insertWorkspaceRowsInTransaction } from "@/api/lib/workspaces/create-workspace-row";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { authorizedMcpContextForTest } from "@/api/tests/helpers/authorized-mcp-context";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { createTestState } from "@/api/tests/helpers/test-state";

import createSampleCase, { loadSampleCase } from "./create";
import { SAMPLE_FACTS } from "./sample-case.data";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests =
  process.env["STELLA_RUN_POSTGRES_TESTS"] === "true" &&
  databaseUrl !== undefined;
const state = createTestState({ file: import.meta.path, config: env });
const dependencies = {
  broadcastWorkspaceResourceUpdated: () => undefined,
  enqueueImageThumbnailOrMarkFailed: async () => undefined,
  enqueuePdfDerivativeOrMarkFailed: async () => undefined,
  processExtraction: async () => undefined,
  enqueueEntitySearchRepairs,
  flushEntitySearchRepairs: async () => ({ failed: 0, repaired: 0 }),
  requestNativeExtractionRun: async () => null,
} satisfies CreateEntityFromBufferDependencies;

type SampleFixture = {
  first: Parameters<typeof loadSampleCase>[0];
  second: Parameters<typeof loadSampleCase>[0];
  db: GatedTestDb;
  requests: ReturnType<typeof startFakeS3>;
  statements: string[];
};

const withSampleFixture = async (
  run: (fixture: SampleFixture) => Promise<void>,
) => {
  await withGatedTestClients(
    databaseUrl ?? panic("Sample tests need DATABASE_URL"),
    async ({ openClient }) => {
      const { db } = openClient();
      const statements: string[] = [];
      const other = openClient({
        logger: {
          logQuery: (query) => {
            statements.push(query);
          },
        },
      }).db;
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const requests = startFakeS3();
      state.setConfig("FEATURE_LEGAL_LISTS", true);
      state.setConfig("FEATURE_FILE_USAGE_LIMITS", false);
      state.setConfig("API_FEATURE_ACCESS_GRANTS", {
        [LEGAL_LISTS_FEATURE_ID]: [{ type: "organization", organizationId }],
        [LIST_VERIFICATION_FEATURE_ID]: [
          { type: "organization", organizationId },
        ],
      });
      try {
        await db.insert(organization).values({
          id: organizationId,
          name: "Sample firm",
          slug: organizationId,
          createdAt: new Date(),
        });
        await db.insert(user).values({
          id: userId,
          name: "Sample user",
          email: `${userId}@example.test`,
          emailVerified: true,
        });
        await db.insert(member).values({
          id: mintAuthProviderIdValue(),
          organizationId,
          userId,
          role: "owner",
          createdAt: new Date(),
        });
        await db.transaction(async (tx) => {
          await insertWorkspaceRowsInTransaction({
            tx,
            rows: [
              {
                id: workspaceId,
                organizationId,
                name: "Sample matter",
                reference: workspaceId,
                visibility: MATTER_VISIBILITY.assignedOnly,
                leadUserId: userId,
              },
            ],
          });
          await tx.insert(workspaceMembers).values({ workspaceId, userId });
        });
        await db.insert(properties).values({
          id: createSafeId<"property">(),
          workspaceId,
          name: "Documents",
          status: "fresh",
          content: { type: "file", version: 1 },
          tool: { type: "manual-input", version: 1 },
        });
        const recordAuditEvent = createBackgroundAuditRecorder({
          organizationId,
          workspaceId,
          userId,
          execution: {
            performer: { type: "user", id: userId },
            trigger: { type: "direct" },
          },
        });
        const shared = {
          organizationId,
          workspaceId,
          userId,
          recordAuditEvent,
          filePropertyName: "Documents",
          createDocument: async (
            input: Parameters<typeof createEntityFromBuffer>[0],
          ) => await createEntityFromBuffer({ ...input, dependencies }),
        };
        await run({
          db,
          requests,
          statements,
          first: {
            ...shared,
            scopedDb: createScopedDb(
              markRlsDatabase(db),
              [workspaceId],
              organizationId,
              userId,
            ),
          },
          second: {
            ...shared,
            scopedDb: createScopedDb(
              markRlsDatabase(other),
              [workspaceId],
              organizationId,
              userId,
            ),
          },
        });
      } finally {
        requests.stop();
        await db.transaction(async (tx) => {
          await lockMatterStewardship({
            tx,
            requests: [
              {
                organizationId,
                workspaceIds: [workspaceId],
                userIds: [userId],
              },
            ],
            mode: "update",
          });
          await tx
            .delete(organization)
            .where(eq(organization.id, organizationId));
        });
        await db.delete(user).where(eq(user.id, userId));
      }
    },
  );
};

const assertSample = async ({
  db,
  first: { workspaceId },
  requests,
}: SampleFixture) => {
  expect(
    await db.$count(legalLists, eq(legalLists.workspaceId, workspaceId)),
  ).toBe(1);
  expect(
    await db.$count(
      legalListItems,
      eq(legalListItems.workspaceId, workspaceId),
    ),
  ).toBe(19);
  expect(
    await db.$count(
      legalListFactDetails,
      eq(legalListFactDetails.workspaceId, workspaceId),
    ),
  ).toBe(19);
  expect(
    await db.$count(
      entities,
      and(eq(entities.workspaceId, workspaceId), eq(entities.kind, "document")),
    ),
  ).toBe(1);
  expect(
    await db.$count(
      entities,
      and(
        eq(entities.workspaceId, workspaceId),
        eq(entities.listItemType, LIST_ITEM_TYPE.FACT),
      ),
    ),
  ).toBe(19);
  const facts = await db
    .select({ name: entities.name, detail: legalListFactDetails })
    .from(legalListFactDetails)
    .innerJoin(entities, eq(entities.id, legalListFactDetails.itemEntityId))
    .where(eq(legalListFactDetails.workspaceId, workspaceId));
  expect(facts.map(({ name }) => name).toSorted()).toEqual(
    SAMPLE_FACTS.map(({ statement }) => statement).toSorted(),
  );
  for (const { name, detail } of facts) {
    const expected =
      SAMPLE_FACTS.find(({ statement }) => statement === name) ??
      panic("Unexpected sample fact");
    expect(detail).toMatchObject(expected.details);
  }
  expect(requests.objects.size).toBe(1);
};

describe.skipIf(!runPostgresTests)("atomic sample case loading", () => {
  test("document-only consent refuses sample loading without creating rows", async () => {
    await withSampleFixture(async (fixture) => {
      const {
        scopedDb,
        workspaceId,
        organizationId,
        userId,
        recordAuditEvent,
      } = fixture.first;
      const safeDb = safeDbFromScoped(scopedDb);
      const featureAccessSnapshot = await scopedDb(
        async (tx) =>
          await resolveFeatureAccessSnapshot({ tx, organizationId, userId }),
      );
      const context = authorizedMcpContextForTest({
        organizationId,
        userId,
        userEmail: `${userId}@example.test`,
        memberRole: "owner",
        accessibleWorkspaceIds: [workspaceId],
        accessibleWorkspaceIdSet: new Set([workspaceId]),
        accessibleWorkspaceStatusById: new Map([[workspaceId, "active"]]),
        accessibleWorkspaces: [{ id: workspaceId, status: "active" }],
        safeDb,
        scopedDb,
        recordAuditEvent,
        featureAccessSnapshot,
        grantedScopes: ["stella:documents_write"],
        request: new Request("https://example.test/mcp"),
        createOperationDatabaseScope: () => ({
          safeDb,
          scopedDb,
          pinServerValidatedWorkspaceId: (id) => id === workspaceId,
        }),
      });
      const result = await handleMcpToolCall({
        mode: "advanced",
        toolName: "write_capability",
        context,
        args: {
          capability: "lists.sample-case.create",
          input: {
            params: { matterId: workspaceId },
            body: { filePropertyName: "Documents" },
          },
        },
      });
      expect(result.isError).toBe(true);
      const response = result.content.at(0);
      const text =
        response?.type === "text"
          ? response.text
          : panic("Expected a text admission refusal");
      expect(JSON.parse(text)).toMatchObject({
        error: {
          code: "missing_scope",
          message: expect.stringContaining("stella:matters_write"),
        },
      });
      for (const table of [
        entities,
        legalLists,
        legalListItems,
        legalListFactDetails,
        pendingUploads,
        auditLogs,
      ]) {
        expect(
          await fixture.db.$count(table, eq(table.workspaceId, workspaceId)),
        ).toBe(0);
      }
      expect(fixture.requests.requests).toHaveLength(0);
    });
  }, 120_000);

  test("concurrent callers commit one complete sample and reclaim the losing document", async () => {
    await withSampleFixture(async (fixture) => {
      let entered = 0;
      const gate = Promise.withResolvers<undefined>();
      const createDocument = async (
        input: Parameters<typeof createEntityFromBuffer>[0],
      ) => {
        entered++;
        if (entered === 2) {
          gate.resolve(undefined);
        }
        await gate.promise;
        return await createEntityFromBuffer({ ...input, dependencies });
      };
      const [first, second] = await Promise.all([
        loadSampleCase({ ...fixture.first, createDocument }),
        loadSampleCase({ ...fixture.second, createDocument }),
      ]);
      if (first.isErr()) {
        throw first.error;
      }
      if (second.isErr()) {
        throw second.error;
      }
      expect(first.value).toEqual(second.value);
      await assertSample(fixture);
      expect(
        fixture.requests.requests.filter(({ method }) => method === "PUT"),
      ).toHaveLength(2);
      expect(
        fixture.requests.requests.filter(({ method }) => method === "DELETE"),
      ).toHaveLength(1);
      const document = await fixture.db.query.entities.findFirst({
        where: { id: { eq: first.value.documentEntityId } },
        with: { currentVersion: { with: { fields: true } } },
      });
      expect(document?.currentVersion?.fields.map(({ id }) => id)).toContain(
        first.value.fileFieldId,
      );
    });
  }, 120_000);

  test("a creator refused before its callback still returns the competing commit", async () => {
    await withSampleFixture(async (fixture) => {
      let entered = 0;
      const result = await loadSampleCase({
        ...fixture.first,
        createDocument: async () => {
          entered++;
          const winner = await loadSampleCase(fixture.second);
          if (winner.isErr()) {
            throw winner.error;
          }
          return Result.err(
            new OrganizationFileUsageError({
              reason: "capacity_exceeded",
              message: "Document capacity reached",
            }),
          );
        },
      });
      if (result.isErr()) {
        throw result.error;
      }
      expect(entered).toBe(1);
      const replay = await loadSampleCase(fixture.second);
      if (replay.isErr()) {
        throw replay.error;
      }
      expect(result.value).toEqual(replay.value);
      await assertSample(fixture);
    });
  }, 120_000);

  test("a matter without a file property gets exactly one and the sample", async () => {
    await withSampleFixture(async (fixture) => {
      const { workspaceId } = fixture.first;
      await fixture.db
        .delete(properties)
        .where(eq(properties.workspaceId, workspaceId));
      const [first, second] = await Promise.all([
        loadSampleCase(fixture.first),
        loadSampleCase(fixture.second),
      ]);
      if (first.isErr()) {
        throw first.error;
      }
      if (second.isErr()) {
        throw second.error;
      }
      expect(second.value).toEqual(first.value);
      expect(
        await fixture.db.$count(
          properties,
          eq(properties.workspaceId, workspaceId),
        ),
      ).toBe(1);
      await assertSample(fixture);
    });
  }, 120_000);

  test("an ordinary same-name list does not claim the sample identity", async () => {
    await withSampleFixture(async (fixture) => {
      const ordinaryId = createSafeId<"legalList">();
      await fixture.db.insert(legalLists).values({
        id: ordinaryId,
        workspaceId: fixture.first.workspaceId,
        name: "Whitfield sample facts",
        createdBy: fixture.first.userId,
      });
      const loaded = await loadSampleCase(fixture.first);
      if (loaded.isErr()) {
        throw loaded.error;
      }
      expect(loaded.value.listId).not.toBe(ordinaryId);
      expect(
        await fixture.db.$count(
          legalLists,
          eq(legalLists.workspaceId, fixture.first.workspaceId),
        ),
      ).toBe(2);
      expect(
        await fixture.db.$count(
          legalListItems,
          eq(legalListItems.listId, ordinaryId),
        ),
      ).toBe(0);
      expect(
        await fixture.db.$count(
          legalListItems,
          eq(legalListItems.listId, loaded.value.listId),
        ),
      ).toBe(19);
      const replay = await loadSampleCase(fixture.second);
      if (replay.isErr()) {
        throw replay.error;
      }
      expect(replay.value).toEqual(loaded.value);
    });
  }, 120_000);

  test("replay after renaming returns the receipt without database or object-store writes", async () => {
    await withSampleFixture(async (fixture) => {
      const initial = await loadSampleCase(fixture.first);
      if (initial.isErr()) {
        throw initial.error;
      }
      await fixture.db
        .update(legalLists)
        .set({ name: "Renamed facts" })
        .where(eq(legalLists.id, initial.value.listId));
      const before = {
        audits: await fixture.db.$count(
          auditLogs,
          eq(auditLogs.workspaceId, fixture.first.workspaceId),
        ),
        uploads: await fixture.db.$count(
          pendingUploads,
          eq(pendingUploads.workspaceId, fixture.first.workspaceId),
        ),
        requests: fixture.requests.requests.length,
      };
      fixture.statements.length = 0;
      const replay = await loadSampleCase({
        ...fixture.second,
        createDocument: async () => panic("Replay must not create a document"),
      });
      if (replay.isErr()) {
        throw replay.error;
      }
      expect(replay.value).toEqual(initial.value);
      expect(
        fixture.statements.some((query) =>
          /^\s*(?:insert|update|delete)\b/iu.test(query),
        ),
      ).toBe(false);
      expect(fixture.requests.requests.length).toBe(before.requests);
      expect(
        await fixture.db.$count(
          auditLogs,
          eq(auditLogs.workspaceId, fixture.first.workspaceId),
        ),
      ).toBe(before.audits);
      expect(
        await fixture.db.$count(
          pendingUploads,
          eq(pendingUploads.workspaceId, fixture.first.workspaceId),
        ),
      ).toBe(before.uploads);
      await assertSample(fixture);
    });
  }, 120_000);

  type FreshSampleOptions = {
    fixture: SampleFixture;
    stale: Awaited<ReturnType<typeof loadSampleCase>>;
    priorFacts: "retained" | "deleted";
  };

  const assertFreshSample = async ({
    fixture,
    stale,
    priorFacts,
  }: FreshSampleOptions) => {
    if (stale.isErr()) {
      throw stale.error;
    }
    const fresh = await loadSampleCase(fixture.second);
    if (fresh.isErr()) {
      throw fresh.error;
    }
    expect(fresh.value.listId).not.toBe(stale.value.listId);
    const document = await fixture.db.query.entities.findFirst({
      where: {
        id: { eq: fresh.value.documentEntityId },
        workspaceId: { eq: fixture.first.workspaceId },
      },
      with: { currentVersion: { with: { fields: true } } },
    });
    expect(document?.currentVersion?.fields.map(({ id }) => id)).toContain(
      fresh.value.fileFieldId,
    );
    const facts = await fixture.db
      .select({ name: entities.name, detail: legalListFactDetails })
      .from(legalListItems)
      .innerJoin(entities, eq(entities.id, legalListItems.entityId))
      .innerJoin(
        legalListFactDetails,
        eq(legalListFactDetails.itemEntityId, legalListItems.entityId),
      )
      .where(eq(legalListItems.listId, fresh.value.listId))
      .orderBy(legalListItems.position);
    expect(facts).toHaveLength(SAMPLE_FACTS.length);
    for (const [position, expected] of SAMPLE_FACTS.entries()) {
      // Surviving facts keep their names, so the replacement uses free siblings.
      expect(facts.at(position)).toMatchObject({
        name:
          priorFacts === "retained"
            ? `${expected.statement}_1`
            : expected.statement,
        detail: expected.details,
      });
    }
    const released = await fixture.db.query.legalLists.findFirst({
      where: { id: { eq: stale.value.listId } },
    });
    expect(released?.sampleCase).toBeNull();
    const replay = await loadSampleCase({
      ...fixture.first,
      createDocument: async () => panic("Replay must not create a document"),
    });
    if (replay.isErr()) {
      throw replay.error;
    }
    expect(replay.value).toEqual(fresh.value);
  };

  test("a deleted sample document releases the receipt and the next load is complete", async () => {
    await withSampleFixture(async (fixture) => {
      const stale = await loadSampleCase(fixture.first);
      if (stale.isErr()) {
        throw stale.error;
      }
      await fixture.db
        .delete(entities)
        .where(eq(entities.id, stale.value.documentEntityId));
      await assertFreshSample({ fixture, stale, priorFacts: "retained" });
    });
  }, 120_000);

  test("deleted sample facts release the receipt and the next load is complete", async () => {
    await withSampleFixture(async (fixture) => {
      const stale = await loadSampleCase(fixture.first);
      if (stale.isErr()) {
        throw stale.error;
      }
      await fixture.db
        .delete(entities)
        .where(
          and(
            eq(entities.workspaceId, fixture.first.workspaceId),
            eq(entities.listItemType, LIST_ITEM_TYPE.FACT),
          ),
        );
      await assertFreshSample({ fixture, stale, priorFacts: "deleted" });
    });
  }, 120_000);

  test("a failed detail transaction leaves no sample or document and a retry succeeds", async () => {
    await withSampleFixture(async (fixture) => {
      const recordAuditEvent: typeof fixture.first.recordAuditEvent = async (
        tx,
        events,
      ) => {
        await fixture.first.recordAuditEvent(tx, events);
        if (Array.isArray(events)) {
          throw new HandlerError({
            status: 503,
            code: "internal_error",
            message: "Sample audit unavailable",
          });
        }
      };
      const failed = await loadSampleCase({
        ...fixture.first,
        recordAuditEvent,
      });
      expect(failed).toMatchObject({
        status: "error",
        error: { status: 503, message: "Sample audit unavailable" },
      });
      expect(
        await fixture.db.$count(
          legalLists,
          eq(legalLists.workspaceId, fixture.first.workspaceId),
        ),
      ).toBe(0);
      expect(
        await fixture.db.$count(
          entities,
          eq(entities.workspaceId, fixture.first.workspaceId),
        ),
      ).toBe(0);
      expect(fixture.requests.objects.size).toBe(0);
      const retry = await loadSampleCase(fixture.second);
      if (retry.isErr()) {
        throw retry.error;
      }
      await assertSample(fixture);
    });
  }, 120_000);

  test("the safe handler refuses a caller without the verification grant before writes", async () => {
    await withSampleFixture(async ({ first }) => {
      const featureAccessSnapshot = createFeatureAccessSnapshot({
        organizationId: first.organizationId,
        userId: first.userId,
        decisions: new Map(
          [LEGAL_LISTS_FEATURE_ID, LIST_VERIFICATION_FEATURE_ID].map(
            (featureId) => [
              featureId,
              decideFeatureAccess({
                registry: FEATURE_REGISTRY,
                featureId,
                organizationId: first.organizationId,
                userId: first.userId,
                membership: true,
                user: { email: "member@example.test", emailVerified: true },
                grants: {
                  [LEGAL_LISTS_FEATURE_ID]: [
                    {
                      type: "organization",
                      organizationId: first.organizationId,
                    },
                  ],
                },
              }),
            ],
          ),
        ),
      });
      const result = await createSampleCase.handler(
        createTestHandlerContext<
          Parameters<typeof createSampleCase.handler>[0]
        >({
          audit: NO_AUDIT,
          scopedDb: NO_DB,
          safeDb: NO_DB,
          workspaceId: first.workspaceId,
          session: { activeOrganizationId: first.organizationId },
          user: { id: first.userId },
          featureAccessSnapshot,
          body: {},
        }),
      );
      expect(result).toBeInstanceOf(HttpStatusResponse);
      if (result instanceof HttpStatusResponse) {
        expect(result.code).toBe(404);
      }
    });
  }, 120_000);
});
