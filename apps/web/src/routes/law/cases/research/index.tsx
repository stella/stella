import { useState } from "react";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { MoreHorizontalIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/alert-dialog";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import { Skeleton } from "@stll/ui/skeleton";
import { stellaToast } from "@stll/ui/toast";

import {
  researchTableKeys,
  researchTablesInfiniteOptions,
} from "@/features/case-law/research/queries";
import type { ResearchTableSummary } from "@/features/case-law/research/queries";
import { useFormatter } from "@/i18n/formatting-context";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { parseDeterministicDate } from "@/lib/deterministic-date";
import { unwrapEden } from "@/lib/errors/api";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteInfiniteQueryData } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import { loadAuthContext } from "@/routes/-auth-context";

export const Route = createFileRoute("/law/cases/research/")({
  // Research tables belong to a signed-in member. The law shell is public, so
  // the gate lives here, on the server as well as the client.
  beforeLoad: async ({ context: { queryClient }, location }) => {
    const auth = await loadAuthContext(queryClient);
    const activeOrganizationId = auth.session?.activeOrganizationId;
    if (!activeOrganizationId) {
      throw redirect({
        to: "/auth",
        search: { redirectTo: location.pathname },
      });
    }
    return { activeOrganizationId };
  },
  loader: async ({ context: { activeOrganizationId, queryClient } }) => {
    await ensureRouteInfiniteQueryData(
      queryClient,
      researchTablesInfiniteOptions({ activeOrganizationId }),
    );
  },
  head: () => ({ meta: [{ title: pageTitle("caseLaw.research.title") }] }),
  component: ResearchTablesPage,
  pendingComponent: ResearchTablesPending,
});

const SKELETON_KEYS = ["a", "b", "c"] as const;

function ResearchTablesPending() {
  const t = useTranslations();
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <h1 className="text-lg font-semibold">{t("caseLaw.research.title")}</h1>
      <ul className="flex flex-col gap-2">
        {SKELETON_KEYS.map((key) => (
          <li className="rounded-md border px-4 py-3" key={key}>
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="mt-2 h-3 w-1/2" />
          </li>
        ))}
      </ul>
    </main>
  );
}

function ResearchTablesPage() {
  const t = useTranslations();
  const { activeOrganizationId } = Route.useRouteContext({
    select: (context) => ({
      activeOrganizationId: context.activeOrganizationId,
    }),
  });
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery(researchTablesInfiniteOptions({ activeOrganizationId }));
  const tables = data ? data.pages.flatMap((page) => page.items) : [];

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{t("caseLaw.research.title")}</h1>
        <Button render={<Link to="/law/cases" />} size="sm" variant="ghost">
          {t("common.caseLaw")}
        </Button>
      </div>

      {tables.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t("caseLaw.research.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {tables.map((table) => (
            <ResearchTableListItem key={table.id} table={table} />
          ))}
        </ul>
      )}

      {hasNextPage && (
        <div className="flex justify-center py-4">
          <Button
            disabled={isFetchingNextPage}
            onClick={() => {
              detached(fetchNextPage(), "case-law.research.fetch-next-page");
            }}
            variant="outline"
          >
            {t("common.loadMore")}
          </Button>
        </div>
      )}
    </main>
  );
}

function ResearchTableListItem({ table }: { table: ResearchTableSummary }) {
  const t = useTranslations();
  const format = useFormatter();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const remove = useMutation({
    mutationFn: async () =>
      unwrapEden(
        await api.case
          .research({ tableId: toSafeId<"caseLawResearchTable">(table.id) })
          .delete(),
      ),
    onSuccess: async () => {
      setDeleteOpen(false);
      await queryClient.invalidateQueries({ queryKey: researchTableKeys.all });
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("common.somethingWentWrong"),
        type: "error",
      });
    },
  });

  const updatedAt = parseDeterministicDate(table.updatedAt);

  return (
    <li className="hover:bg-muted/50 flex items-start justify-between gap-3 rounded-md border px-4 py-3 transition-colors">
      <Link
        className="min-w-0 flex-1"
        params={{ tableId: table.id }}
        to="/law/cases/research/$tableId"
      >
        <span className="text-foreground block truncate font-medium">
          <BidiText>{table.name}</BidiText>
        </span>
        <span className="text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          <span className="truncate">
            {t("caseLaw.research.savedQuery")}: {table.savedQuery.query}
          </span>
          {updatedAt !== null && (
            <span>
              {t("caseLaw.research.updated", {
                date: format.dateTime(updatedAt, { dateStyle: "medium" }),
              })}
            </span>
          )}
        </span>
      </Link>
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label={t("common.actions")}
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <MoreHorizontalIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => setDeleteOpen(true)}>
            {t("common.delete")}
          </MenuItem>
        </MenuPopup>
      </Menu>
      <AlertDialog onOpenChange={setDeleteOpen} open={deleteOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("caseLaw.research.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("caseLaw.research.deleteConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <Button
              disabled={remove.isPending}
              onClick={() => {
                detached(remove.mutateAsync(), "case-law.research.delete");
              }}
              variant="destructive"
            >
              {t("common.delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </li>
  );
}
