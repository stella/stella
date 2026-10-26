import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ArrowLeftIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";

import { InvoiceComposer } from "@/components/billing/invoice-composer";
import { usePermissions } from "@/hooks/use-permissions";
import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { ensureRouteQueryData } from "@/lib/react-query";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";
import { expensesOptions } from "@/lib/workspaces/queries/expenses";
import { invoicePrefillOptions } from "@/lib/workspaces/queries/invoices";
import { timeEntriesOptions } from "@/lib/workspaces/queries/time-entries";
import { prefetchPendingApprovals } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/new-invoice-loader";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/invoices/new",
)({
  beforeLoad: async ({ context, params }) => {
    const role = await ensureRouteQueryData(context.queryClient, roleOptions);
    if (
      !authClient.organization.checkRolePermission({
        role,
        permissions: { invoice: ["create"] },
      })
    ) {
      redirect({
        to: "/workspaces/$workspaceId/invoices",
        params: { workspaceId: params.workspaceId },
        throw: true,
      });
    }
  },
  loader: async ({ context, params }) => {
    // A hint only: never awaited, so a failed count cannot block the route.
    detached(
      prefetchPendingApprovals({
        queryClient: context.queryClient,
        userId: context.user.id,
        workspaceId: params.workspaceId,
      }),
      "invoice-composer.prefetch-pending-approvals",
    );
    await ensureRouteQueryData(
      context.queryClient,
      invoicePrefillOptions(params.workspaceId),
    );
  },
  pendingComponent: NewInvoicePending,
  component: NewInvoicePage,
});

const PageHeader = ({ workspaceId }: { workspaceId: string }) => {
  const t = useTranslations();
  return (
    <div className="flex items-center gap-3 border-b px-4 py-3">
      <Link params={{ workspaceId }} to="/workspaces/$workspaceId/invoices">
        <Button aria-label={t("common.back")} size="icon" variant="ghost">
          <DirectionalIcon className="size-4" icon={ArrowLeftIcon} />
        </Button>
      </Link>
      <h1 className="text-sm font-medium">
        {t("billing.invoiceComposer.title")}
      </h1>
    </div>
  );
};

function NewInvoicePending() {
  const workspaceId = Route.useParams({ select: (p) => p.workspaceId });
  return (
    <div className="flex h-full flex-col">
      <PageHeader workspaceId={workspaceId} />
      <div className="flex flex-col gap-4 p-4 sm:p-6">
        <div className="flex gap-2">
          <Skeleton className="h-7 w-20 rounded-full" />
          <Skeleton className="h-7 w-20 rounded-full" />
          <Skeleton className="h-7 w-20 rounded-full" />
        </div>
        <Skeleton className="h-64 w-full rounded-2xl" />
        <Skeleton className="h-24 w-full rounded-2xl" />
      </div>
    </div>
  );
}

function NewInvoicePage() {
  const workspaceId = Route.useParams({ select: (p) => p.workspaceId });
  const { data: prefill } = useSuspenseQuery(
    invoicePrefillOptions(workspaceId),
  );
  const userId = Route.useRouteContext({
    select: (context) => context.user.id,
  });
  // Only someone who can approve is sent to the approval queue; the API
  // lists every timekeeper's drafts to them alone.
  const canApprove = usePermissions({ timeEntry: ["approve"] });
  const canApproveExpenses = usePermissions({ expense: ["update"] });
  // The count is a hint; a failed read reports itself and shows no count.
  const pendingTime = useQueryView(
    useQuery({
      ...timeEntriesOptions(workspaceId, userId, { status: "draft" }),
      enabled: canApprove,
    }),
  );
  useQueryViewError(pendingTime, "NewInvoicePage:pending-time");
  const pendingExpenses = useQueryView(
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
    <div className="flex h-full flex-col">
      <PageHeader workspaceId={workspaceId} />
      <ScrollArea className="flex-1">
        {/* Keyed so another matter starts from its own selection. */}
        <InvoiceComposer
          key={workspaceId}
          prefill={prefill}
          pendingApprovalCount={canApprove ? pendingCount : 0}
          workspaceId={workspaceId}
        />
      </ScrollArea>
    </div>
  );
}
