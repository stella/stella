import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { workspaces } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { readMatterInvoicePrefills } from "@/api/lib/billing/invoice-prefill-operation";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const prefillClientInvoice = createSafeRootHandler(
  {
    contract: "patch",
    description:
      "Prepare grouped unbilled work for a client's accessible matters. Optional inclusive periodStart and periodEnd select work dates. At most 50 matters and 500 items per matter. Pass selected matter and entry IDs to client-invoices.create; no draft is saved by this read.",
    permissions: { invoice: ["create"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    access: "read",
    mcp: {
      type: "capability",
      readClass: "tenant",
      reason: "billing_admin",
      consumesServices: false,
    },
    params: t.Object({ clientId: tSafeId("contact") }),
    query: t.Object({
      periodStart: t.Optional(t.String({ format: "date" })),
      periodEnd: t.Optional(t.String({ format: "date" })),
    }),
  },
  async function* ({ safeDb, session, params, query }) {
    if (
      query.periodStart &&
      query.periodEnd &&
      query.periodStart > query.periodEnd
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Period end must follow period start",
        }),
      );
    }
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const client = await tx.query.contacts.findFirst({
          where: {
            id: { eq: params.clientId },
            organizationId: { eq: session.activeOrganizationId },
          },
          columns: { id: true },
        });
        if (!client) {
          return Result.err(
            new HandlerError({ status: 404, message: "Client not found" }),
          );
        }
        const rows = await tx
          .select({
            workspaceId: workspaces.id,
            name: workspaces.name,
            color: workspaces.color,
          })
          .from(workspaces)
          .where(
            and(
              eq(workspaces.clientId, params.clientId),
              eq(workspaces.organizationId, session.activeOrganizationId),
              eq(workspaces.status, "active"),
            ),
          )
          .orderBy(workspaces.id)
          .limit(LIMITS.clientInvoiceMatters + 1);
        if (rows.length > LIMITS.clientInvoiceMatters) {
          return Result.err(
            new HandlerError({
              status: 409,
              message: "Select a smaller set of client matters",
              hint: "Use invoices.prefill for individual matters.",
            }),
          );
        }
        const prefills = await readMatterInvoicePrefills(tx, {
          organizationId: session.activeOrganizationId,
          workspaceIds: rows.map((row) => row.workspaceId),
          periodStart: query.periodStart,
          periodEnd: query.periodEnd,
        });
        if (prefills.isErr()) {
          return Result.err(prefills.error);
        }
        const itemCount = prefills.value.reduce(
          (count, { prefill }) =>
            count + prefill.timeEntries.length + prefill.expenses.length,
          0,
        );
        if (itemCount > LIMITS.invoiceLinesPerInvoice) {
          return Result.err(
            new HandlerError({
              status: 409,
              message: "Narrow the billing period to preview fewer work items",
            }),
          );
        }
        const prefillByMatter = new Map(
          prefills.value.map((row) => [row.workspaceId, row.prefill]),
        );
        const matters = rows.map((matter) => ({
          ...matter,
          prefill:
            prefillByMatter.get(matter.workspaceId) ??
            panic("Selected invoice matter has no prefill"),
        }));
        return Result.ok({ clientId: params.clientId, matters });
      }),
    );
    return result;
  },
);
export default prefillClientInvoice;
