import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

type ClientInvoiceMatterSelection = {
  workspaceId: SafeId<"workspace">;
  timeEntryIds: readonly SafeId<"timeEntry">[];
  expenseIds: readonly SafeId<"expense">[];
};

export const validateClientInvoiceSelection = (
  matters: readonly ClientInvoiceMatterSelection[],
) => {
  const first = matters.at(0);
  if (first === undefined) {
    return Result.err(
      new HandlerError({ status: 400, message: "Select a matter" }),
    );
  }
  const ids = matters.map((m) => m.workspaceId);
  if (
    matters.some((m) => m.timeEntryIds.length + m.expenseIds.length === 0) ||
    new Set(ids).size !== ids.length ||
    matters.reduce(
      (sum, m) => sum + m.timeEntryIds.length + m.expenseIds.length,
      0,
    ) > LIMITS.invoiceLinesPerInvoice
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Select distinct matters and at most ${LIMITS.invoiceLinesPerInvoice} invoice lines`,
      }),
    );
  }
  return Result.ok({ ids, first });
};

type ResolveClientInvoiceMattersOptions = {
  organizationId: SafeId<"organization">;
  clientId: SafeId<"contact">;
  workspaceIds: readonly SafeId<"workspace">[];
};

export const resolveClientInvoiceMatters = async (
  tx: Pick<Transaction, "select">,
  {
    organizationId,
    clientId,
    workspaceIds,
  }: ResolveClientInvoiceMattersOptions,
) => {
  const selected = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        inArray(workspaces.id, workspaceIds),
        eq(workspaces.organizationId, organizationId),
        eq(workspaces.clientId, clientId),
      ),
    )
    .orderBy(workspaces.id)
    .limit(workspaceIds.length);
  return selected.length === workspaceIds.length
    ? Result.ok(selected)
    : Result.err(
        new HandlerError({
          status: 404,
          message: "Some client matters were not found or are inaccessible",
        }),
      );
};
