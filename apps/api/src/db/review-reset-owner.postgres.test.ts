import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";
import { createTestState } from "@stll/test-state";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  auditLogs,
  entities,
  INVOICE_PAYMENT_ORIGIN,
  INVOICE_STATUS,
  invoicePayments,
  invoices,
  pendingUploads,
  properties,
  requestIdempotencyReceipts,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import type { RlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import type { CreateEntityFromBufferDependencies } from "@/api/lib/entities/create-from-buffer";
import { serverBuiltFileEncryption } from "@/api/lib/files/detect-file-encryption";
import { cents } from "@/api/lib/money";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { ReviewOrganizationConfigurationMissing } from "@/api/lib/review-organization/config";
import { createMembershipFence } from "@/api/lib/review-organization/reset";
import { clearReviewOrganizationBilling } from "@/api/lib/review-organization/reset-scope";
import { createRootMembershipScopedDb } from "@/api/lib/root-scoped-db";
import { enqueueEntitySearchRepairs } from "@/api/lib/search/projection-repair-queue";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { createUngatedTableGateForTests } from "./online-ddl";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import {
  RegisteredReviewReset,
  ReviewResetNotRegistered,
} from "./review-reset-owner";
import { REVIEW_RESET_REGISTRATION } from "./review-reset-registration";
import { reviewResetOrganizations } from "./schema/review-reset-organizations";

const testState = createTestState({ file: import.meta.path, config: {} });

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const documentDependencies = {
  broadcastWorkspaceResourceUpdated: () => undefined,
  enqueueImageThumbnailOrMarkFailed: async () => undefined,
  enqueuePdfDerivativeOrMarkFailed: async () => undefined,
  processExtraction: async () => undefined,
  requestNativeExtractionRun: async () => null,
  enqueueEntitySearchRepairs,
  flushEntitySearchRepairs: async () => ({ failed: 0, repaired: 0 }),
} satisfies CreateEntityFromBufferDependencies;

const nativeFencedRlsDatabase = (
  database: GatedTestDb,
  assertFence: (tx: Transaction) => Promise<void>,
): RlsDatabase<Transaction> =>
  markRlsDatabase({
    transaction: async <T>(fn: (tx: Transaction) => Promise<T>) =>
      await database.transaction(async (rawTx) => {
        const tx = asTestRaw<Transaction>(rawTx);
        await assertFence(tx);
        return await fn(tx);
      }),
  });

describe.skipIf(!enabled)("registered organization reset (postgres)", () => {
  test("migration registration is idempotent and requires its configured identity", async () => {
    const organizationId = mintAuthProviderId<"organization">();
    testState.setEnv("APP_REVIEW_ORGANIZATION_ID", organizationId);
    testState.setEnv(
      "APP_REVIEW_ACCOUNT_EMAIL",
      "reset-registration@example.test",
    );
    await withGatedTestClients(
      process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL"),
      async ({ openClient }) => {
        const { db, sql: native } = openClient({ max: 1 });
        const connection = {
          query: async (statement, parameters = []) =>
            await native.unsafe<unknown[]>(statement, [...parameters]),
          execute: async (statement, parameters = []) => {
            await native.unsafe(statement, [...parameters]);
          },
          release: () => {},
        } satisfies OnlineMigrationConnection;
        try {
          expect(
            await REVIEW_RESET_REGISTRATION.readCompletion(connection),
          ).toMatchObject({ type: "incomplete" });
          const tables = createUngatedTableGateForTests(connection);
          expect(
            await REVIEW_RESET_REGISTRATION.repair(connection, tables),
          ).toEqual({ type: "complete" });
          expect(
            await REVIEW_RESET_REGISTRATION.repair(connection, tables),
          ).toEqual({ type: "complete" });
          expect(
            await REVIEW_RESET_REGISTRATION.readCompletion(connection),
          ).toEqual({ type: "complete" });
          expect(
            await db.$count(
              reviewResetOrganizations,
              eq(reviewResetOrganizations.organizationId, organizationId),
            ),
          ).toBe(1);
          testState.setEnv("APP_REVIEW_ORGANIZATION_ID", "");
          expect(
            await rejectionOf(
              REVIEW_RESET_REGISTRATION.readCompletion(connection),
            ),
          ).toBeInstanceOf(ReviewOrganizationConfigurationMissing);
          expect(
            await rejectionOf(
              REVIEW_RESET_REGISTRATION.repair(connection, tables),
            ),
          ).toBeInstanceOf(ReviewOrganizationConfigurationMissing);
        } finally {
          await db
            .delete(reviewResetOrganizations)
            .where(eq(reviewResetOrganizations.organizationId, organizationId));
        }
      },
    );
  });

  test("only a registered reset removes its organization's retained records", async () => {
    await withGatedTestClients(
      process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL"),
      async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const b = await flowReviewGateFixture(db, { intermediate: false });
        const invoiceA = createSafeId<"invoice">();
        const invoiceB = createSafeId<"invoice">();
        try {
          await db.insert(invoices).values([
            {
              id: invoiceA,
              organizationId: a.organizationId,
              workspaceId: a.workspaceId,
              invoiceNumber: "RESET-A",
              invoiceDate: "2026-10-29",
              currency: "EUR",
              status: INVOICE_STATUS.SENT,
              totalAmount: cents(100),
            },
            {
              id: invoiceB,
              organizationId: b.organizationId,
              workspaceId: b.workspaceId,
              invoiceNumber: "RESET-B",
              invoiceDate: "2026-10-29",
              currency: "EUR",
              status: INVOICE_STATUS.SENT,
              totalAmount: cents(100),
            },
          ]);
          await db.insert(invoicePayments).values([
            {
              organizationId: a.organizationId,
              invoiceId: invoiceA,
              amount: cents(100),
              paidOn: "2026-10-29",
              method: "other",
              origin: INVOICE_PAYMENT_ORIGIN.LEGACY,
              recordedBy: null,
            },
            {
              organizationId: b.organizationId,
              invoiceId: invoiceB,
              amount: cents(100),
              paidOn: "2026-10-29",
              method: "other",
              origin: INVOICE_PAYMENT_ORIGIN.LEGACY,
              recordedBy: null,
            },
          ]);
          await db
            .insert(reviewResetOrganizations)
            .values({ organizationId: a.organizationId });
          const refused = await Result.tryPromise({
            try: async () =>
              await withAggregateTransaction(
                db,
                async (tx) =>
                  await RegisteredReviewReset.admit({
                    tx,
                    organizationId: b.organizationId,
                    userId: b.userId,
                  }),
              ),
            catch: (cause) => cause,
          });
          expect(refused.isErr()).toBe(true);
          if (refused.isErr()) {
            expect(refused.error).toBeInstanceOf(ReviewResetNotRegistered);
          }

          expect(
            await db
              .delete(invoicePayments)
              .where(eq(invoicePayments.invoiceId, invoiceA))
              .returning({ id: invoicePayments.id }),
          ).toEqual([]);
          const asApp = createScopedDb(
            markRlsDatabase(db),
            [a.workspaceId],
            a.organizationId,
            a.userId,
          );
          expect(
            await asApp(
              async (tx) =>
                await tx
                  .delete(invoicePayments)
                  .where(eq(invoicePayments.invoiceId, invoiceA))
                  .returning({ id: invoicePayments.id }),
            ),
          ).toEqual([]);
          const appRegistration = await Result.tryPromise(
            async () =>
              await asApp(
                async (tx) =>
                  await tx.execute(
                    sql`INSERT INTO public.review_reset_organizations (organization_id) VALUES (${b.organizationId})`,
                  ),
              ),
          );
          expect(appRegistration.isErr()).toBe(true);
          if (appRegistration.isErr()) {
            expect(getPgErrorCode(appRegistration.error)).toBe(
              PG_ERROR.INSUFFICIENT_PRIVILEGE,
            );
          }

          await withAggregateTransaction(db, async (tx) => {
            const owner = await RegisteredReviewReset.admit({
              tx,
              organizationId: a.organizationId,
              userId: a.userId,
            });
            expect(
              await owner.run(
                async (scopedTx) =>
                  await scopedTx
                    .delete(invoices)
                    .where(eq(invoices.id, invoiceB))
                    .returning({ id: invoices.id }),
              ),
            ).toEqual([]);
          });
          const resetRegistration = await Result.tryPromise(
            async () =>
              await withAggregateTransaction(db, async (tx) => {
                const owner = await RegisteredReviewReset.admit({
                  tx,
                  organizationId: a.organizationId,
                  userId: a.userId,
                });
                return await owner.run(
                  async (scopedTx) =>
                    await scopedTx.execute(
                      sql`INSERT INTO public.review_reset_organizations (organization_id) VALUES (${b.organizationId})`,
                    ),
                );
              }),
          );
          expect(resetRegistration.isErr()).toBe(true);
          if (resetRegistration.isErr()) {
            expect(getPgErrorCode(resetRegistration.error)).toBe(
              PG_ERROR.INSUFFICIENT_PRIVILEGE,
            );
          }
          const removed = await withAggregateTransaction(
            db,
            async (tx) =>
              await clearReviewOrganizationBilling(tx, a.organizationId),
          );
          expect(removed.get("invoices")).toBe(1);
          expect(
            await db.$count(
              invoicePayments,
              eq(invoicePayments.invoiceId, invoiceA),
            ),
          ).toBe(0);
          expect(
            await db.$count(
              invoicePayments,
              eq(invoicePayments.invoiceId, invoiceB),
            ),
          ).toBe(1);
          expect(
            await db.$count(
              reviewResetOrganizations,
              eq(reviewResetOrganizations.organizationId, b.organizationId),
            ),
          ).toBe(0);
        } finally {
          await db
            .delete(reviewResetOrganizations)
            .where(
              eq(reviewResetOrganizations.organizationId, a.organizationId),
            );
          await b.cleanup();
          await a.cleanup();
        }
      },
    );
  });

  test("registered reset receipts stay organization-bound and outside app user scope", async () => {
    await withGatedTestClients(
      process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL"),
      async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const b = await flowReviewGateFixture(db, { intermediate: false });
        const otherUserId = mintAuthProviderId<"user">();
        const claimedAt = new Date("2026-10-30T12:00:00.000Z");
        const otherUserReceiptId = createSafeId<"requestIdempotencyReceipt">();
        const organizationReceiptId =
          createSafeId<"requestIdempotencyReceipt">();
        const ownReceiptId = createSafeId<"requestIdempotencyReceipt">();
        type ReceiptFixtureOptions = Pick<
          typeof requestIdempotencyReceipts.$inferInsert,
          "id" | "organizationId" | "userId" | "idempotencyKey"
        >;
        const receiptValues = ({
          id,
          organizationId,
          userId,
          idempotencyKey,
        }: ReceiptFixtureOptions) => ({
          id,
          organizationId,
          userId,
          idempotencyKey,
          route: "/v1/reset-fixture/:id",
          requestFingerprint: "a".repeat(64),
          state: "completed" as const,
          responseCode: 200,
          responseBody: { id },
          claimedAt,
          completedAt: claimedAt,
        });

        try {
          await db.insert(user).values({
            id: otherUserId,
            name: "Other organization member",
            email: `${otherUserId}@example.test`,
            emailVerified: true,
          });
          await db.insert(member).values({
            id: Bun.randomUUIDv7(),
            organizationId: a.organizationId,
            userId: otherUserId,
            role: "member",
            createdAt: claimedAt,
          });

          const appA = createScopedDb(
            markRlsDatabase(db),
            [a.workspaceId],
            a.organizationId,
            a.userId,
          );
          const appOtherUser = createScopedDb(
            markRlsDatabase(db),
            [],
            a.organizationId,
            otherUserId,
          );
          const appB = createScopedDb(
            markRlsDatabase(db),
            [b.workspaceId],
            b.organizationId,
            b.userId,
          );
          await appA(
            async (tx) =>
              await tx.insert(requestIdempotencyReceipts).values(
                receiptValues({
                  id: ownReceiptId,
                  organizationId: a.organizationId,
                  userId: a.userId,
                  idempotencyKey: `own-${ownReceiptId}`,
                }),
              ),
          );
          await appOtherUser(
            async (tx) =>
              await tx.insert(requestIdempotencyReceipts).values(
                receiptValues({
                  id: otherUserReceiptId,
                  organizationId: a.organizationId,
                  userId: otherUserId,
                  idempotencyKey: `other-user-${otherUserReceiptId}`,
                }),
              ),
          );
          await appB(
            async (tx) =>
              await tx.insert(requestIdempotencyReceipts).values(
                receiptValues({
                  id: organizationReceiptId,
                  organizationId: b.organizationId,
                  userId: b.userId,
                  idempotencyKey: `other-organization-${organizationReceiptId}`,
                }),
              ),
          );
          await db
            .insert(reviewResetOrganizations)
            .values({ organizationId: a.organizationId });

          const refused = await Result.tryPromise({
            try: async () =>
              await withAggregateTransaction(
                db,
                async (tx) =>
                  await RegisteredReviewReset.admit({
                    tx,
                    organizationId: b.organizationId,
                    userId: b.userId,
                  }),
              ),
            catch: (cause) => cause,
          });
          expect(refused.isErr()).toBe(true);
          if (refused.isErr()) {
            expect(refused.error).toBeInstanceOf(ReviewResetNotRegistered);
          }

          expect(
            await appA(
              async (tx) =>
                await tx
                  .delete(requestIdempotencyReceipts)
                  .where(eq(requestIdempotencyReceipts.id, otherUserReceiptId))
                  .returning({ id: requestIdempotencyReceipts.id }),
            ),
          ).toEqual([]);
          expect(
            await appA(
              async (tx) =>
                await tx
                  .delete(requestIdempotencyReceipts)
                  .where(
                    eq(requestIdempotencyReceipts.id, organizationReceiptId),
                  )
                  .returning({ id: requestIdempotencyReceipts.id }),
            ),
          ).toEqual([]);
          expect(
            await appA(
              async (tx) =>
                await tx
                  .delete(requestIdempotencyReceipts)
                  .where(eq(requestIdempotencyReceipts.id, ownReceiptId))
                  .returning({ id: requestIdempotencyReceipts.id }),
            ),
          ).toEqual([{ id: ownReceiptId }]);

          const reset = await withAggregateTransaction(db, async (tx) => {
            const owner = await RegisteredReviewReset.admit({
              tx,
              organizationId: a.organizationId,
              userId: a.userId,
            });
            return await owner.run(async (scopedTx) => ({
              organizationRows: await scopedTx
                .delete(requestIdempotencyReceipts)
                .where(
                  eq(
                    requestIdempotencyReceipts.organizationId,
                    a.organizationId,
                  ),
                )
                .returning({ id: requestIdempotencyReceipts.id }),
              otherOrganizationRows: await scopedTx
                .delete(requestIdempotencyReceipts)
                .where(
                  eq(
                    requestIdempotencyReceipts.organizationId,
                    b.organizationId,
                  ),
                )
                .returning({ id: requestIdempotencyReceipts.id }),
            }));
          });
          expect(reset.organizationRows).toEqual([{ id: otherUserReceiptId }]);
          expect(reset.otherOrganizationRows).toEqual([]);
          expect(
            await db.$count(
              requestIdempotencyReceipts,
              eq(requestIdempotencyReceipts.organizationId, a.organizationId),
            ),
          ).toBe(0);
          expect(
            await db.$count(
              requestIdempotencyReceipts,
              eq(requestIdempotencyReceipts.organizationId, b.organizationId),
            ),
          ).toBe(1);
        } finally {
          await db
            .delete(reviewResetOrganizations)
            .where(
              eq(reviewResetOrganizations.organizationId, a.organizationId),
            );
          await b.cleanup();
          await a.cleanup();
          await db.delete(user).where(eq(user.id, otherUserId));
        }
      },
    );
  });

  test("a join after file preflight refuses publication and deletes the uploaded bytes", async () => {
    await withGatedTestClients(
      process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL"),
      async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await flowReviewGateFixture(db, {
          intermediate: false,
        });
        const otherUserId = mintAuthProviderId<"user">();
        const propertyId = createSafeId<"property">();
        const fakeS3 = startFakeS3();
        let fenceChecks = 0;
        const fence = createMembershipFence(
          {
            organizationId: fixture.organizationId,
            userId: fixture.userId,
            email: `${fixture.userId}@example.test`,
            role: "owner",
          },
          async () => {
            fenceChecks += 1;
          },
        );
        const rlsDatabase = asTestRaw<RlsDatabase<Transaction>>(db);
        const scopedDb = createRootMembershipScopedDb(
          { organizationId: fixture.organizationId, userId: fixture.userId },
          nativeFencedRlsDatabase(db, async (tx) => await fence.assert(tx)),
        );
        const preflightDb = createRootMembershipScopedDb(
          { organizationId: fixture.organizationId, userId: fixture.userId },
          rlsDatabase,
        );
        await db.insert(user).values({
          id: otherUserId,
          name: "New organization member",
          email: `${otherUserId}@example.test`,
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        await db.insert(properties).values({
          id: propertyId,
          workspaceId: fixture.workspaceId,
          name: "Documents",
          status: "fresh",
          content: { type: "file", version: 1 },
          tool: { type: "manual-input", version: 1 },
        });
        const before = {
          audits: await db.$count(
            auditLogs,
            eq(auditLogs.organizationId, fixture.organizationId),
          ),
          intents: await db.$count(
            pendingUploads,
            eq(pendingUploads.organizationId, fixture.organizationId),
          ),
        };
        const requestsBefore = fakeS3.requests.length;
        const objectsBefore = [...fakeS3.objects.keys()].toSorted();
        const put = fakeS3.holdNext({
          method: "PUT",
          keyIncludes: fixture.workspaceId,
        });
        try {
          const pending = createEntityFromBuffer({
            scopedDb,
            preflightDb,
            organizationId: fixture.organizationId,
            workspaceId: fixture.workspaceId,
            userId: fixture.userId,
            recordAuditEvent: fixture.recordAuditEvent,
            buffer: new TextEncoder().encode("membership fence document"),
            fileName: "Membership fence.pdf",
            mimeType: "application/pdf",
            encryption: serverBuiltFileEncryption(),
            dependencies: documentDependencies,
          });
          await put.reached;
          const checksBeforePublication = fenceChecks;
          await db.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId: fixture.organizationId,
            userId: otherUserId,
            role: "member",
            createdAt: new Date(),
          });
          put.release();
          expect(await rejectionOf(pending)).toMatchObject({
            _tag: "ReviewMembershipChangedError",
            message:
              "The review organization has members other than the review account",
          });
          expect(checksBeforePublication).toBe(1);
          expect(
            await db.$count(
              entities,
              and(
                eq(entities.workspaceId, fixture.workspaceId),
                eq(entities.name, "Membership fence.pdf"),
              ),
            ),
          ).toBe(0);
          expect(
            await db.$count(
              auditLogs,
              eq(auditLogs.organizationId, fixture.organizationId),
            ),
          ).toBe(before.audits);
          expect(
            await db.$count(
              pendingUploads,
              eq(pendingUploads.organizationId, fixture.organizationId),
            ),
          ).toBe(before.intents + 1);
          expect(
            fakeS3.requests
              .slice(requestsBefore)
              .filter(({ method }) => method === "DELETE"),
          ).toHaveLength(1);
          expect(
            fakeS3.requests
              .slice(requestsBefore)
              .filter(({ method }) => method === "PUT"),
          ).toHaveLength(1);
          expect([...fakeS3.objects.keys()].toSorted()).toEqual(objectsBefore);
        } finally {
          put.release();
          fakeS3.stop();
          await fixture.cleanup();
          await db.delete(user).where(eq(user.id, otherUserId));
        }
      },
    );
  });
});
