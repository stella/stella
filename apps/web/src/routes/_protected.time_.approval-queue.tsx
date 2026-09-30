import { useState } from "react";

import {
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { parsePlainDate } from "@stll/time";
import { Button } from "@stll/ui/button";
import { ScrollArea } from "@stll/ui/scroll-area";

import { ApprovalFiltersForm } from "@/features/time-approval-queue/approval-filters";
import { applyApprovalResults } from "@/features/time-approval-queue/approval-state";
import {
  ApprovalTable,
  ApprovalTablePending,
} from "@/features/time-approval-queue/approval-table";
import { normalizeApprovalFilters } from "@/features/time-approval-queue/filters.logic";
import type { ApprovalFilters } from "@/features/time-approval-queue/filters.logic";
import { useApprovalMutations } from "@/features/time-approval-queue/mutations";
import { approvalQueueOptions } from "@/features/time-approval-queue/queries";
import type {
  ApprovalEntry,
  ApprovalResult,
} from "@/features/time-approval-queue/queries";
import { ReturnDialog } from "@/features/time-approval-queue/return-dialog";
import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { localISODate } from "@/lib/local-iso-date";
import { organizationOptions } from "@/lib/organization/queries";
import { pageTitle } from "@/lib/page-title";
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
} from "@/lib/react-query";
import { workspacesRouteOptions } from "@/lib/workspaces/queries";

const optionalDate = (value: unknown) =>
  typeof value === "string" && parsePlainDate(value) !== null
    ? value
    : undefined;
const optionalId = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : undefined;

export const Route = createFileRoute("/_protected/time_/approval-queue")({
  validateSearch: (search) => {
    const from = optionalDate(search["from"]);
    const to = optionalDate(search["to"]);
    const member = optionalId(search["member"]);
    const matter = optionalId(search["matter"]);
    return normalizeApprovalFilters({ from, to, member, matter });
  },
  loaderDeps: ({ search }) => search,
  beforeLoad: async ({ context }) => {
    if (!isTimeBillingRouteEnabled()) {
      redirect({ to: "/workspaces", throw: true });
    }
    const role = await ensureRouteQueryData(context.queryClient, roleOptions);
    if (
      !authClient.organization.checkRolePermission({
        role,
        permissions: { timeEntry: ["read"] },
      })
    ) {
      redirect({ to: "/workspaces", throw: true });
    }
  },
  loader: async ({ context, deps }) => {
    const organizationId = context.user.activeOrganizationId;
    await Promise.all([
      ensureRouteInfiniteQueryData(
        context.queryClient,
        approvalQueueOptions({
          organizationId,
          userId: context.user.id,
          filters: deps,
        }),
      ),
      ensureRouteQueryData(
        context.queryClient,
        organizationOptions(organizationId),
      ),
      ensureRouteQueryData(
        context.queryClient,
        workspacesRouteOptions(organizationId),
      ),
    ]);
  },
  head: () => ({ meta: [{ title: pageTitle("billing.approvalQueue.title") }] }),
  pendingComponent: ApprovalPending,
  component: ApprovalPage,
});

function ApprovalPending() {
  const t = useTranslations();
  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <h1 className="text-sm font-medium">
          {t("billing.approvalQueue.title")}
        </h1>
      </div>
      <div className="p-4">
        <ApprovalTablePending />
      </div>
    </div>
  );
}

function ApprovalPage() {
  const filters = Route.useSearch({
    select: ({ from, to, member, matter }) => ({ from, to, member, matter }),
  });
  return <ApprovalContent filters={filters} key={JSON.stringify(filters)} />;
}

function ApprovalContent({ filters }: { filters: ApprovalFilters }) {
  const t = useTranslations();
  const user = Route.useRouteContext({ select: (context) => context.user });
  const identity = {
    organizationId: user.activeOrganizationId,
    userId: user.id,
  };
  const navigate = Route.useNavigate();
  const query = useSuspenseInfiniteQuery(
    approvalQueueOptions({ ...identity, filters }),
  );
  const { data: organization } = useSuspenseQuery(
    organizationOptions(identity.organizationId),
  );
  const { data: mattersData } = useSuspenseQuery(
    workspacesRouteOptions(identity.organizationId),
  );
  const members = new Map(
    organization.members.map((member) => [member.userId, member.user.name]),
  );
  const matters = new Map(
    mattersData.workspaces.map((matter) => [matter.id, matter.name]),
  );
  const { approve, returnEntry } = useApprovalMutations(identity);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [refusedEntries, setRefusedEntries] = useState<ApprovalEntry[]>([]);
  const [results, setResults] = useState<ApprovalResult[]>([]);
  const [returning, setReturning] = useState<ApprovalEntry | null>(null);
  const pageEntries = query.data.pages.flatMap((page) => page.items);
  const entries = [
    ...new Map(
      [...pageEntries, ...refusedEntries].map((entry) => [entry.id, entry]),
    ).values(),
  ];
  const pending = approve.isPending || returnEntry.isPending;

  const approveIds = (ids: string[]) => {
    approve.mutate(ids, {
      onSuccess: (nextResults) => {
        const next = applyApprovalResults({
          entries,
          selectedIds,
          results: nextResults,
        });
        const refusedIds = new Set(
          nextResults
            .filter((result) => result.status === "refused")
            .map((result) => result.id),
        );
        const submittedIds = new Set(ids);
        setSelectedIds(next.selectedIds);
        setRefusedEntries([
          ...refusedEntries.filter((entry) => !submittedIds.has(entry.id)),
          ...next.entries.filter((entry) => refusedIds.has(entry.id)),
        ]);
        setResults([
          ...results.filter((result) => !submittedIds.has(result.id)),
          ...nextResults,
        ]);
      },
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <h1 className="text-sm font-medium">
          {t("billing.approvalQueue.title")}
        </h1>
        <Link
          className="text-sm hover:underline"
          to="/time"
          search={{ date: localISODate() }}
        >
          {t("billing.timesheets")}
        </Link>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
          <ApprovalFiltersForm
            filters={filters}
            pending={pending}
            members={members}
            matters={matters}
            onApply={(nextFilters) =>
              detached(
                navigate({ search: normalizeApprovalFilters(nextFilters) }),
                "approval-queue.filters",
              )
            }
          />
          <ApprovalTable
            entries={entries}
            results={results}
            selectedIds={selectedIds}
            onSelectedIdsChange={setSelectedIds}
            onApprove={approveIds}
            onReturn={setReturning}
            pending={pending}
            members={members}
            matters={matters}
          />
          {query.hasNextPage && (
            <Button
              disabled={query.isFetchingNextPage || pending}
              onClick={() =>
                detached(query.fetchNextPage(), "approval-queue.load-more")
              }
              variant="outline"
            >
              {t("common.loadMore")}
            </Button>
          )}
        </div>
      </ScrollArea>
      <ReturnDialog
        entry={returning}
        key={returning?.id ?? "closed"}
        pending={pending}
        onClose={() => setReturning(null)}
        onReturn={(comment) => {
          if (!returning) {
            return;
          }
          const id = returning.id;
          returnEntry.mutate(
            { id, comment },
            {
              onSuccess: () => {
                setReturning(null);
                setSelectedIds((current) =>
                  current.filter((selected) => selected !== id),
                );
                setRefusedEntries((current) =>
                  current.filter((entry) => entry.id !== id),
                );
                setResults((current) =>
                  current.filter((result) => result.id !== id),
                );
              },
            },
          );
        }}
      />
    </div>
  );
}
