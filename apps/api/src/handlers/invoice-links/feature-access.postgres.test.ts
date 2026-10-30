import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { invoiceSends } from "@/api/db/schema";
import {
  createScopedDb,
  createTenantlessDb,
  markRlsDatabase,
} from "@/api/db/scoped";
import { env } from "@/api/env";
import { verifyInvoiceLinkCaller } from "@/api/handlers/invoice-links/link-access";
import { createSendInvoice } from "@/api/handlers/invoices/sends/create";
import listInvoiceSends from "@/api/handlers/invoices/sends/list";
import revokeInvoiceSend from "@/api/handlers/invoices/sends/revoke";
import {
  createInvoiceLinkToken,
  hashInvoiceLinkToken,
} from "@/api/lib/billing/invoice-links";
import { createSafeId } from "@/api/lib/branded-types";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
import type { TokenScopedDatabase } from "@/api/lib/root-scoped-db";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { seedInvoiceSendScaling } from "@/api/tests/read-scaling/invoice-sends";

const state = createTestState({ file: import.meta.path, config: env });

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "organization invoice link authority under PostgreSQL RLS",
  () => {
    test("deployment and organization grants gate authenticated operations and token-derived tenants", async () => {
      state.setConfig("FEATURE_TIME_BILLING", true);
      state.setConfig("FEATURE_INVOICE_LINKS", true);
      const url = process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(url, async ({ openClient }) => {
        const db = markRlsDatabase(openClient({ max: 1 }).db);
        const a = await seedInvoiceSendScaling(db, 1);
        const b = await seedInvoiceSendScaling(db, 1);
        const orgA = a.context.session.activeOrganizationId;
        const orgB = b.context.session.activeOrganizationId;
        const token = createInvoiceLinkToken();
        const sendId = createSafeId<"invoiceSend">();
        try {
          await db.insert(invoiceSends).values({
            id: sendId,
            organizationId: orgA,
            invoiceId: a.invoiceId,
            recipients: ["recipient@example.test"],
            language: "en",
            replyTo: "sender@example.test",
            tokenHash: hashInvoiceLinkToken(token),
            expiresAt: new Date(Date.now() + 86_400_000),
          });
          await db
            .update(invoiceSends)
            .set({ deliveryStatus: "delivered" })
            .where(eq(invoiceSends.id, sendId));
          const tokenDb = {
            tenantless: asTestRaw<TokenScopedDatabase["tenantless"]>(
              createTenantlessDb(db),
            ),
            scoped: ({ organizationId, userId, workspaceIds }) =>
              asTestRaw<ReturnType<TokenScopedDatabase["scoped"]>>(
                createScopedDb(db, workspaceIds, organizationId, userId),
              ),
          } satisfies TokenScopedDatabase;
          const verify = verifyInvoiceLinkCaller({
            db: tokenDb,
            isAvailable: () => true,
            admitToken: async () => Result.ok(undefined),
          });
          const open = async (candidate: string) =>
            await verify({
              request: new Request("https://example.test/link"),
              params: {},
              query: {},
              body: { token: candidate },
            });
          let deliveries = 0;
          const send = createSendInvoice({
            isDeliveryConfigured: () => true,
            deliver: async () => {
              deliveries += 1;
            },
            admitEmail: async () =>
              Result.ok({ release: async () => {}, commit: async () => {} }),
          });
          for (const deployed of [false, true]) {
            for (const granted of [false, true]) {
              state.setConfig("FEATURE_INVOICE_LINKS", deployed);
              state.setConfig("API_FEATURE_ACCESS_GRANTS", {
                "invoice-links": granted
                  ? [{ type: "organization", organizationId: orgA }]
                  : [],
              });
              const context = (fixture: typeof a) => ({
                ...fixture.context,
                featureAccessSnapshot: buildFeatureAccessSnapshot({
                  organizationId: fixture.context.session.activeOrganizationId,
                  userId: fixture.context.user.id,
                  identity: {
                    email: fixture.context.user.email,
                    emailVerified: true,
                  },
                  enrolments: [
                    {
                      organizationId:
                        fixture.context.session.activeOrganizationId,
                      userId: fixture.context.user.id,
                      featureId: "time-billing",
                    },
                  ],
                }),
              });
              const listed = await listInvoiceSends.handler(
                createTestHandlerContext<
                  Parameters<typeof listInvoiceSends.handler>[0]
                >({
                  ...context(a),
                  params: {
                    workspaceId: a.context.workspaceId,
                    invoiceId: a.invoiceId,
                  },
                  query: {},
                  scopedDb: NO_DB,
                  audit: a.context.audit,
                }),
              );
              const enabled = deployed && granted;
              expect("items" in listed).toBe(enabled);
              const opened = await open(token);
              expect(opened.isOk()).toBe(enabled);
              if (opened.isErr()) {
                const unknown = await open(createInvoiceLinkToken());
                expect(unknown.isErr()).toBe(true);
                if (unknown.isErr()) {
                  expect(opened.error).toMatchObject({
                    status: unknown.error.status,
                    code: unknown.error.code,
                    message: unknown.error.message,
                    hint: unknown.error.hint,
                  });
                }
              }
              const sent = await send.handler(
                createTestHandlerContext<Parameters<typeof send.handler>[0]>({
                  ...context(b),
                  params: {
                    workspaceId: b.context.workspaceId,
                    invoiceId: b.invoiceId,
                  },
                  body: { recipients: ["other@example.test"] },
                  scopedDb: NO_DB,
                  audit: b.context.audit,
                }),
              );
              expect(sent).toMatchObject({ code: 404 });
              if (!enabled) {
                const refused = await send.handler(
                  createTestHandlerContext<Parameters<typeof send.handler>[0]>({
                    ...context(a),
                    params: {
                      workspaceId: a.context.workspaceId,
                      invoiceId: a.invoiceId,
                    },
                    body: { recipients: ["sender@example.test"] },
                    scopedDb: NO_DB,
                    audit: a.context.audit,
                  }),
                );
                expect(refused).toMatchObject({ code: 404 });
                expect(
                  await revokeInvoiceSend.handler(
                    createTestHandlerContext<
                      Parameters<typeof revokeInvoiceSend.handler>[0]
                    >({
                      ...context(a),
                      params: {
                        workspaceId: a.context.workspaceId,
                        invoiceId: a.invoiceId,
                        sendId,
                      },
                      scopedDb: NO_DB,
                      audit: a.context.audit,
                    }),
                  ),
                ).toMatchObject({ code: 404 });
              }
            }
          }
          expect(deliveries).toBe(0);
          const queued = createSendInvoice({
            isDeliveryConfigured: () => true,
            admitEmail: async () => {
              state.setConfig("API_FEATURE_ACCESS_GRANTS", {});
              return Result.ok({
                release: async () => {},
                commit: async () => {},
              });
            },
            deliver: async () => {
              deliveries += 1;
            },
          });
          const stopped = await queued.handler(
            createTestHandlerContext<Parameters<typeof queued.handler>[0]>({
              ...a.context,
              params: {
                workspaceId: a.context.workspaceId,
                invoiceId: a.invoiceId,
              },
              body: { recipients: ["removed@example.test"] },
              scopedDb: NO_DB,
              audit: a.context.audit,
            }),
          );
          expect(stopped).toMatchObject({ code: 502 });
          expect(deliveries).toBe(0);
          // A grant for another tenant never validates an already sent token.
          state.setConfig("API_FEATURE_ACCESS_GRANTS", {
            "invoice-links": [{ type: "organization", organizationId: orgB }],
          });
          expect((await open(token)).isErr()).toBe(true);
          expect(
            await db
              .select()
              .from(invoiceSends)
              .where(eq(invoiceSends.id, sendId)),
          ).toHaveLength(1);
        } finally {
          await b.cleanup();
          await a.cleanup();
        }
      });
    });
  },
);
