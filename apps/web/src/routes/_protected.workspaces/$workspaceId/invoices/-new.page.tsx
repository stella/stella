import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ScrollArea } from "@stll/ui/scroll-area";

import { InvoiceComposer } from "@/components/billing/invoice-composer";
import { usePermissions } from "@/hooks/use-permissions";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";
import { expensesOptions } from "@/lib/workspaces/queries/expenses";
import { invoicePrefillOptions } from "@/lib/workspaces/queries/invoices";
import { timeEntriesOptions } from "@/lib/workspaces/queries/time-entries";

import { NewInvoiceBackIcon, NewInvoiceShell } from "./-new.pending";

const routeApi = getRouteApi(
  "/_protected/workspaces/$workspaceId/invoices/new",
);

export function NewInvoicePage() {
  const t = useTranslations();
  const workspaceId = routeApi.useParams({ select: (p) => p.workspaceId });
  const { data: prefill } = useSuspenseQuery(
    invoicePrefillOptions(workspaceId),
  );
  const userId = routeApi.useRouteContext({
    select: (context) => context.user.id,
  });
  // Only someone who can approve is sent to the approval queue; the API
  // lists every timekeeper's submitted time to them alone.
  const canApprove = usePermissions({ timeEntry: ["approve"] });
  const canApproveExpenses = usePermissions({ expense: ["update"] });
  // The count is a hint; a failed read reports itself and shows no count.
  const pendingTime = queryView(
    useQuery({
      ...timeEntriesOptions(workspaceId, userId, { status: "submitted" }),
      enabled: canApprove,
    }),
  );
  useQueryViewError(pendingTime, "NewInvoicePage:pending-time");
  const pendingExpenses = queryView(
    useQuery({
      ...expensesOptions(workspaceId, { status: "draft" }),
      enabled: canApprove && canApproveExpenses,
    }),
  );
  useQueryViewError(pendingExpenses, "NewInvoicePage:pending-expenses");
  const pendingCount =
    (pendingTime.type === "items" ? pendingTime.items.length : 0) +
    (pendingExpenses.type === "items" ? pendingExpenses.items.length : 0);
  return (
    <NewInvoiceShell
      back={
        <Link params={{ workspaceId }} to="/workspaces/$workspaceId/invoices">
          <Button aria-label={t("common.back")} size="icon" variant="ghost">
            <NewInvoiceBackIcon />
          </Button>
        </Link>
      }
    >
      <ScrollArea className="flex-1">
        {/* Keyed so another matter starts from its own selection. */}
        <InvoiceComposer
          key={workspaceId}
          prefill={prefill}
          pendingApprovalCount={canApprove ? pendingCount : 0}
          workspaceId={workspaceId}
        />
      </ScrollArea>
    </NewInvoiceShell>
  );
}
