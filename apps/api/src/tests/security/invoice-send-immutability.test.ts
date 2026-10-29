import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { member, user as authUser } from "@/api/db/auth-schema";
import {
  INVOICE_SEND_UPDATE_COLUMNS,
  INVOICE_STATUS,
  invoices,
  invoiceSends,
  workspaceMembers,
} from "@/api/db/schema";
import type { InvoiceSendDeliveryStatus } from "@/api/db/schema";
import { createMembershipSafeDb, createScopedDb } from "@/api/db/scoped";
import {
  createInvoiceLinkToken,
  hashInvoiceLinkToken,
} from "@/api/lib/billing/invoice-links";
import { createSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { cents } from "@/api/lib/money";
import { getPgErrorCode } from "@/api/lib/pg-error";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

let fixture: Awaited<ReturnType<typeof getRlsFixture>>;
// timeout: initializes the shared database schema and its RLS fixture.
beforeAll(
  async () => {
    fixture = await getRlsFixture();
  },
  { timeout: 30_000 },
);
afterAll(async () => {
  await releaseRlsFixture();
});

const seedSend = async (
  deliveryStatus: InvoiceSendDeliveryStatus = "delivered",
) => {
  const { testDb, ids } = fixture;
  const invoiceId = createSafeId<"invoice">();
  const sendId = createSafeId<"invoiceSend">();
  const tokenHash = hashInvoiceLinkToken(createInvoiceLinkToken());
  await testDb.insert(invoices).values({
    id: invoiceId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    invoiceNumber: `IMMUTABLE-${invoiceId}`,
    invoiceDate: "2026-10-01",
    currency: "EUR",
    status: INVOICE_STATUS.SENT,
    sentAt: new Date(),
    totalAmount: cents(1000),
  });
  const safeDb = createMembershipSafeDb(testDb, {
    organizationId: ids.orgA,
    userId: ids.userA1,
    serverValidatedWorkspaceIds: [ids.wsA1],
    featureAccessSnapshot: enrolledTimeBillingSnapshot({
      organizationId: ids.orgA,
      userId: ids.userA1,
    }),
  });
  const values = {
    id: sendId,
    organizationId: ids.orgA,
    invoiceId,
    sentByUserId: ids.userA1,
    recipients: ["client@example.test"],
    language: "en",
    replyTo: "billing@example.test",
    tokenHash,
    expiresAt: new Date(Date.now() + 86_400_000),
    deliveryStatus: "pending",
  } satisfies typeof invoiceSends.$inferInsert;
  (
    await safeDb(async (tx) => {
      await tx.insert(invoiceSends).values(values);
      if (deliveryStatus !== "pending") {
        await tx
          .update(invoiceSends)
          .set({ deliveryStatus })
          .where(eq(invoiceSends.id, sendId));
      }
    })
  ).unwrap();
  return { invoiceId, sendId, tokenHash, safeDb, values };
};

describe("invoice send mutation authority", () => {
  test("the application role may update only the delivery and revocation columns", async () => {
    const { testDb } = fixture;
    const columns = await testDb
      .select({ column: sql`a.attname`.mapWith(String) })
      .from(sql`pg_catalog.pg_attribute a`)
      .where(
        sql`a.attrelid = 'public.invoice_sends'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        AND pg_catalog.has_column_privilege('stella', a.attrelid, a.attnum, 'UPDATE')`,
      )
      .orderBy(sql`a.attname`);
    expect(columns).toEqual(
      INVOICE_SEND_UPDATE_COLUMNS.map(({ name }) => name)
        .toSorted()
        .map((column) => ({ column })),
    );
    const privileges = await testDb.execute(
      sql`SELECT pg_catalog.has_table_privilege('stella', 'public.invoice_sends', 'UPDATE') AS table_update`,
    );
    expect(executedRows(privileges)).toEqual([{ table_update: false }]);
  });

  test("application writes cannot change link identity, expiry or the access stamp", async () => {
    const { testDb, ids } = fixture;
    const { invoiceId, sendId, safeDb, values } = await seedSend();
    const sibling = await seedSend();
    const changes = [
      { tokenHash: hashInvoiceLinkToken(createInvoiceLinkToken()) },
      { invoiceId: sibling.invoiceId },
      { organizationId: ids.orgB },
      { expiresAt: new Date(values.expiresAt.getTime() + 86_400_000) },
      { firstViewedAt: new Date() },
    ];
    for (const patch of changes) {
      const refused = await safeDb(async (tx) => {
        await tx
          .update(invoiceSends)
          .set(patch)
          .where(eq(invoiceSends.id, sendId));
      });
      expect(refused.isErr()).toBe(true);
      if (refused.isErr()) {
        expect(getPgErrorCode(refused.error)).toBe("42501");
      }
    }
    const forgedInsert = await safeDb(async (tx) => {
      await tx.insert(invoiceSends).values({
        ...values,
        id: createSafeId<"invoiceSend">(),
        tokenHash: hashInvoiceLinkToken(createInvoiceLinkToken()),
        firstViewedAt: new Date(),
      });
    });
    expect(forgedInsert.isErr()).toBe(true);
    if (forgedInsert.isErr()) {
      expect(getPgErrorCode(forgedInsert.error)).toBe("42501");
    }
    expect(
      await testDb
        .select({
          invoiceId: invoiceSends.invoiceId,
          firstViewedAt: invoiceSends.firstViewedAt,
          expiresAt: invoiceSends.expiresAt,
        })
        .from(invoiceSends)
        .where(eq(invoiceSends.id, sendId)),
    ).toEqual([
      { invoiceId, firstViewedAt: null, expiresAt: values.expiresAt },
    ]);
  });

  test("the owner cannot retarget a credential or extend its expiry", async () => {
    const { testDb, ids } = fixture;
    const { sendId, values } = await seedSend();
    const sibling = await seedSend();
    for (const patch of [
      { tokenHash: hashInvoiceLinkToken(createInvoiceLinkToken()) },
      { invoiceId: sibling.invoiceId },
      { organizationId: ids.orgB },
      { expiresAt: new Date(values.expiresAt.getTime() + 86_400_000) },
    ]) {
      const refused = await Result.tryPromise(async () => {
        await testDb
          .update(invoiceSends)
          .set(patch)
          .where(eq(invoiceSends.id, sendId));
      });
      expect(refused.isErr()).toBe(true);
      if (refused.isErr()) {
        expect(getPgErrorCode(refused.error)).toBe("42501");
      }
    }
  });

  test.each(["member", "anonymous"] as const)(
    "the application and owner cannot change a revocation or its original %s actor",
    async (actor) => {
      const { testDb, ids } = fixture;
      const { sendId, safeDb } = await seedSend();
      const revokedAt = new Date();
      const revokedByUserId = actor === "member" ? ids.userA1 : null;
      (
        await safeDb(async (tx) => {
          await tx
            .update(invoiceSends)
            .set({ revokedAt, revokedByUserId })
            .where(eq(invoiceSends.id, sendId));
        })
      ).unwrap();
      const changes = [
        { revokedAt: null },
        { revokedAt: new Date(revokedAt.getTime() + 1) },
        { revokedByUserId: ids.userA2 },
        ...(actor === "member" ? [{ revokedByUserId: null }] : []),
      ];
      for (const patch of changes) {
        const app = await safeDb(async (tx) => {
          await tx
            .update(invoiceSends)
            .set(patch)
            .where(eq(invoiceSends.id, sendId));
        });
        const owner = await Result.tryPromise(async () => {
          await testDb
            .update(invoiceSends)
            .set(patch)
            .where(eq(invoiceSends.id, sendId));
        });
        for (const result of [app, owner]) {
          expect(result.isErr()).toBe(true);
          if (result.isErr()) {
            expect(getPgErrorCode(result.error)).toBe("42501");
          }
        }
      }
      expect(
        await testDb
          .select({
            revokedAt: invoiceSends.revokedAt,
            revokedByUserId: invoiceSends.revokedByUserId,
          })
          .from(invoiceSends)
          .where(eq(invoiceSends.id, sendId)),
      ).toEqual([{ revokedAt, revokedByUserId }]);
    },
  );

  test.each(["delivered", "partial", "failed"] as const)(
    "pending may complete as %s exactly once, including for the owner",
    async (terminal) => {
      const { testDb } = fixture;
      const { sendId, safeDb } = await seedSend("pending");
      (
        await safeDb(async (tx) => {
          await tx
            .update(invoiceSends)
            .set({ deliveryStatus: terminal })
            .where(eq(invoiceSends.id, sendId));
        })
      ).unwrap();
      for (const status of [
        "pending",
        "delivered",
        "partial",
        "failed",
      ] as const) {
        if (status === terminal) {
          continue;
        }
        const app = await safeDb(async (tx) => {
          await tx
            .update(invoiceSends)
            .set({ deliveryStatus: status })
            .where(eq(invoiceSends.id, sendId));
        });
        const owner = await Result.tryPromise(async () => {
          await testDb
            .update(invoiceSends)
            .set({ deliveryStatus: status })
            .where(eq(invoiceSends.id, sendId));
        });
        for (const result of [app, owner]) {
          expect(result.isErr()).toBe(true);
          if (result.isErr()) {
            expect(getPgErrorCode(result.error)).toBe("42501");
          }
        }
      }
      expect(
        await testDb
          .select({ deliveryStatus: invoiceSends.deliveryStatus })
          .from(invoiceSends)
          .where(eq(invoiceSends.id, sendId)),
      ).toEqual([{ deliveryStatus: terminal }]);
    },
  );

  test.each([
    "delivered",
    "partial",
    "failed",
    "revoked",
    "long-lived",
  ] as const)(
    "neither the application nor the owner can insert an already %s send",
    async (violation) => {
      const { testDb } = fixture;
      const { safeDb, values } = await seedSend();
      const invalid = {
        ...values,
        id: createSafeId<"invoiceSend">(),
        tokenHash: hashInvoiceLinkToken(createInvoiceLinkToken()),
        deliveryStatus:
          violation === "delivered" ||
          violation === "partial" ||
          violation === "failed"
            ? violation
            : "pending",
        ...(violation === "revoked" ? { revokedAt: new Date() } : {}),
        ...(violation === "long-lived"
          ? { expiresAt: new Date(Date.now() + 61 * 86_400_000) }
          : {}),
      } satisfies typeof invoiceSends.$inferInsert;
      const app = await safeDb(async (tx) => {
        await tx.insert(invoiceSends).values(invalid);
      });
      const owner = await Result.tryPromise(async () => {
        await testDb.insert(invoiceSends).values(invalid);
      });
      for (const result of [app, owner]) {
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(getPgErrorCode(result.error)).toBe("42501");
        }
      }
      expect(
        await testDb
          .select({ id: invoiceSends.id })
          .from(invoiceSends)
          .where(eq(invoiceSends.id, invalid.id)),
      ).toEqual([]);
    },
  );

  test("deleting a revoker account preserves its historical identifier and the dead link", async () => {
    const { testDb, ids } = fixture;
    const { sendId, tokenHash } = await seedSend();
    const revokerId = mintAuthProviderId<"user">();
    await testDb.insert(authUser).values({
      id: revokerId,
      name: "Link revoker",
      email: `${revokerId}@example.test`,
      emailVerified: true,
    });
    try {
      await testDb.insert(member).values({
        id: mintAuthProviderIdValue(),
        organizationId: ids.orgA,
        userId: revokerId,
        role: "member",
        createdAt: new Date(),
      });
      await testDb.insert(workspaceMembers).values({
        id: createSafeId<"workspaceMember">(),
        workspaceId: ids.wsA1,
        userId: revokerId,
      });
      const revokerDb = createMembershipSafeDb(testDb, {
        organizationId: ids.orgA,
        userId: revokerId,
        serverValidatedWorkspaceIds: [ids.wsA1],
        featureAccessSnapshot: enrolledTimeBillingSnapshot({
          organizationId: ids.orgA,
          userId: revokerId,
        }),
      });
      const publicDb = createScopedDb(testDb, [], ids.orgA, null);
      const liveBefore = await publicDb(
        async (tx) =>
          await tx.execute(
            sql`SELECT * FROM public.invoice_link_scope(${tokenHash})`,
          ),
      );
      expect(executedRows(liveBefore)).toMatchObject([{ send_id: sendId }]);
      const revokedAt = new Date();
      const revoked = await revokerDb(
        async (tx) =>
          await tx
            .update(invoiceSends)
            .set({ revokedAt, revokedByUserId: revokerId })
            .where(eq(invoiceSends.id, sendId))
            .returning({ id: invoiceSends.id }),
      );
      expect(revoked.unwrap()).toEqual([{ id: sendId }]);
      const deleted = await testDb
        .delete(authUser)
        .where(eq(authUser.id, revokerId))
        .returning({ id: authUser.id });
      expect(deleted).toEqual([{ id: revokerId }]);
      expect(
        await testDb
          .select({
            revokedAt: invoiceSends.revokedAt,
            revokedByUserId: invoiceSends.revokedByUserId,
          })
          .from(invoiceSends)
          .where(eq(invoiceSends.id, sendId)),
      ).toEqual([{ revokedAt, revokedByUserId: revokerId }]);
      const resolution = await publicDb(
        async (tx) =>
          await tx.execute(
            sql`SELECT * FROM public.invoice_link_scope(${tokenHash})`,
          ),
      );
      expect(executedRows(resolution)).toEqual([]);
      const gate = await publicDb(
        async (tx) =>
          await tx.execute(
            sql`SELECT public.invoice_link_mark_viewed(${tokenHash}) AS live`,
          ),
      );
      expect(executedRows(gate)).toEqual([{ live: false }]);
    } finally {
      await testDb.delete(authUser).where(eq(authUser.id, revokerId));
    }
  });

  test("the live-token owner gate can stamp first view while a plain app write cannot", async () => {
    const { testDb, ids } = fixture;
    const { sendId, tokenHash } = await seedSend();
    const tokenScope = createScopedDb(testDb, [], ids.orgA, null);
    const result = await tokenScope(
      async (tx) =>
        await tx.execute(
          sql`SELECT public.invoice_link_mark_viewed(${tokenHash}) AS live`,
        ),
    );
    expect(executedRows(result)).toEqual([{ live: true }]);
    const first =
      (
        await testDb
          .select({ firstViewedAt: invoiceSends.firstViewedAt })
          .from(invoiceSends)
          .where(eq(invoiceSends.id, sendId))
      ).at(0) ??
      panic("The seeded invoice send must remain after its view gate");
    expect(first.firstViewedAt).toBeInstanceOf(Date);
    await tokenScope(
      async (tx) =>
        await tx.execute(
          sql`SELECT public.invoice_link_mark_viewed(${tokenHash})`,
        ),
    );
    expect(
      await testDb
        .select({ firstViewedAt: invoiceSends.firstViewedAt })
        .from(invoiceSends)
        .where(eq(invoiceSends.id, sendId)),
    ).toEqual([first]);
  });
});
