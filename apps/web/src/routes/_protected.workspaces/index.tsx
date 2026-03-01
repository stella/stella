import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Skeleton } from "@stella/ui/components/skeleton";
import { toastManager } from "@stella/ui/components/toast";

import { useI18nStore } from "@/i18n/i18n-store";
import { useCreateWorkspace } from "@/routes/_protected.workspaces/-mutations";
import { workspacesOptions } from "@/routes/_protected.workspaces/-queries";

export const Route = createFileRoute("/_protected/workspaces/")({
  component: RouteComponent,
  pendingComponent: () => (
    <div className="grid auto-rows-min gap-4 border-t p-4 md:grid-cols-3">
      <Skeleton className="h-17 w-full rounded-xl" />
      <Skeleton className="h-17 w-full rounded-xl" />
      <Skeleton className="h-17 w-full rounded-xl" />
    </div>
  ),
});

export type RouteType = typeof Route;

function RouteComponent() {
  const t = useTranslations();
  const lang = useI18nStore((s) => s.lang);
  const { data } = useSuspenseQuery(workspacesOptions);
  const createWorkspace = useCreateWorkspace();
  const isLimitReached = data.workspaces.length >= data.workspacesCountLimit;

  const handleCreateWorkspace = () => {
    createWorkspace.mutate(undefined, {
      onError: () => {
        toastManager.add({
          title: t("errors.actionFailed"),
          type: "error",
        });
      },
    });
  };

  return (
    <div className="flex flex-1 flex-col gap-4 border-t p-4">
      <div className="grid auto-rows-min gap-4 md:grid-cols-3">
        {data.workspaces.map((workspace) => (
          <Link
            className="flex h-17 flex-col justify-between rounded-xl border bg-card px-3 py-2"
            key={workspace.id}
            params={{ workspaceId: workspace.id }}
            to="/workspaces/$workspaceId"
          >
            <div className="flex items-baseline gap-2">
              <h1 className="text-lg font-bold">{workspace.name}</h1>
              {workspace.reference && (
                <span className="font-mono text-sm text-muted-foreground">
                  {workspace.reference}
                </span>
              )}
            </div>
            <span className="text-sm text-muted-foreground">
              {t("common.createdAt", {
                date: new Date(workspace.createdAt).toLocaleString(
                  new Intl.Locale(lang),
                ),
              })}
            </span>
          </Link>
        ))}
      </div>
      {!isLimitReached && (
        <Button
          className="mx-auto"
          disabled={createWorkspace.isPending}
          onClick={handleCreateWorkspace}
        >
          {t("workspaces.createNewWorkspace")}
        </Button>
      )}
    </div>
  );
}
