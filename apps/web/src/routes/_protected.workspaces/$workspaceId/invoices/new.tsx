import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ArrowLeftIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";

import { InvoiceComposer } from "@/components/billing/invoice-composer";
import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { ensureRouteQueryData } from "@/lib/react-query";
import { invoicePrefillOptions } from "@/lib/workspaces/queries/invoices";

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
  return (
    <div className="flex h-full flex-col">
      <PageHeader workspaceId={workspaceId} />
      <ScrollArea className="flex-1">
        {/* Keyed so another matter starts from its own selection. */}
        <InvoiceComposer
          key={workspaceId}
          prefill={prefill}
          workspaceId={workspaceId}
        />
      </ScrollArea>
    </div>
  );
}
