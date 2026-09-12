import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  CalendarClockIcon,
  CheckCircle2Icon,
  Clock3Icon,
  EyeIcon,
  FileTextIcon,
  Link2Icon,
  LoaderCircleIcon,
  LockKeyholeIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@stll/ui/components/alert-dialog";
import { BidiText } from "@stll/ui/components/bidi-text";
import { Button } from "@stll/ui/components/button";
import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/shares",
)({ component: ShareSpacesPage });

const shareSpacesKey = (workspaceId: string) => [
  "workspaces",
  workspaceId,
  "share-spaces",
];

type ShareStatus = "active" | "draft" | "publishing" | "revoked";

const statusStyles: Record<ShareStatus, string> = {
  active: "bg-[var(--option-emerald-bg)] text-[var(--option-emerald-fg)]",
  draft: "bg-muted text-muted-foreground",
  publishing: "bg-[var(--option-amber-bg)] text-[var(--option-amber-fg)]",
  revoked: "bg-muted text-muted-foreground",
};

const statusIcons = {
  active: CheckCircle2Icon,
  draft: Clock3Icon,
  publishing: LoaderCircleIcon,
  revoked: LockKeyholeIcon,
} satisfies Record<ShareStatus, typeof CheckCircle2Icon>;

function ShareSpacesPage() {
  const workspaceId = Route.useParams({
    select: (params) => params.workspaceId,
  });
  const t = useTranslations();
  const formatter = useFormatter();
  const queryClient = useQueryClient();
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const sharesQuery = useQuery({
    queryKey: shareSpacesKey(workspaceId),
    queryFn: async ({ signal }) =>
      unwrapEden(
        await api["workspaces"]({
          workspaceId: toSafeId<"workspace">(workspaceId),
        })["share-spaces"].get({
          query: { limit: 100 },
          fetch: { signal },
        }),
      ),
    refetchInterval: (query) =>
      query.state.data?.items.some((share) => share.status === "publishing")
        ? 3000
        : false,
  });

  const shares = sharesQuery.data?.items ?? [];
  const activeCount = shares.filter(
    (share) => share.status === "active",
  ).length;
  const publishingCount = shares.filter(
    (share) => share.status === "publishing",
  ).length;
  const recipientCount = shares.reduce(
    (total, share) => total + share.recipientCount,
    0,
  );

  const revoke = async (shareSpaceId: string) => {
    setRevokingId(shareSpaceId);
    try {
      unwrapEden(
        await api["workspaces"]({
          workspaceId: toSafeId<"workspace">(workspaceId),
        })
          ["share-spaces"]({
            shareSpaceId: toSafeId<"shareSpace">(shareSpaceId),
          })
          .revoke.post(),
      );
      await queryClient.invalidateQueries({
        queryKey: shareSpacesKey(workspaceId),
      });
      stellaToast.add({
        title: t("sharing.manage.revokedToast"),
        type: "success",
      });
    } catch (error) {
      stellaToast.add({
        title: userErrorFromThrown(error, t("sharing.manage.revokeFailed")),
        type: "error",
      });
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="border-border/70 bg-muted/25 border-b px-6 py-7">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-end justify-between gap-5">
          <div className="flex items-start gap-4">
            <div className="bg-primary text-primary-foreground flex size-12 items-center justify-center rounded-2xl shadow-sm">
              <ShieldCheckIcon className="size-6" />
            </div>
            <div>
              <p className="text-primary mb-1 text-xs font-semibold tracking-wide uppercase">
                {t("sharing.manage.eyebrow")}
              </p>
              <h1 className="font-heading text-2xl font-semibold">
                {t("sharing.manage.title")}
              </h1>
              <p className="text-muted-foreground mt-1 max-w-xl text-sm">
                {t("sharing.manage.description")}
              </p>
            </div>
          </div>
          <div className="text-muted-foreground bg-background flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-xs">
            <LockKeyholeIcon className="text-primary size-3.5" />
            {t("sharing.manage.securityNote")}
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl space-y-6 p-6">
        {sharesQuery.isPending ? (
          <div className="grid gap-3 sm:grid-cols-3">
            {[0, 1, 2].map((item) => (
              <Skeleton className="h-24 rounded-xl" key={item} />
            ))}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard
              icon={CheckCircle2Icon}
              label={t("sharing.manage.activeShares")}
              value={activeCount}
            />
            <StatCard
              icon={LoaderCircleIcon}
              label={t("sharing.manage.preparingShares")}
              value={publishingCount}
            />
            <StatCard
              icon={UsersIcon}
              label={t("sharing.manage.peopleWithAccess")}
              value={recipientCount}
            />
          </div>
        )}

        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-heading text-lg font-semibold">
              {t("sharing.manage.recentShares")}
            </h2>
            <p className="text-muted-foreground text-sm">
              {t("sharing.manage.recentSharesHint")}
            </p>
          </div>
          {sharesQuery.isFetching && !sharesQuery.isPending ? (
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              <LoaderCircleIcon className="size-3.5 animate-spin" />
              {t("sharing.manage.refreshing")}
            </div>
          ) : null}
        </div>

        {sharesQuery.isError ? (
          <div className="border-destructive/25 bg-destructive/5 rounded-xl border p-5">
            <p className="text-destructive font-medium">
              {t("sharing.manage.loadFailed")}
            </p>
            <Button
              className="mt-3"
              onClick={() =>
                detached(sharesQuery.refetch(), "ShareSpaces.retry")
              }
              size="sm"
              variant="outline"
            >
              {t("sharing.manage.tryAgain")}
            </Button>
          </div>
        ) : null}

        {sharesQuery.isPending ? (
          <div className="flex flex-col gap-3">
            {[0, 1, 2].map((item) => (
              <Skeleton className="h-28 rounded-xl" key={item} />
            ))}
          </div>
        ) : null}

        {!sharesQuery.isPending && shares.length === 0 ? (
          <div className="border-border bg-muted/15 relative overflow-hidden rounded-2xl border border-dashed px-6 py-14 text-center">
            <div className="bg-primary/5 absolute start-1/2 -top-20 size-64 -translate-x-1/2 rounded-full blur-3xl" />
            <div className="relative mx-auto flex max-w-md flex-col items-center">
              <div className="bg-background text-primary mb-5 flex size-14 items-center justify-center rounded-2xl border shadow-sm">
                <Link2Icon className="size-6" />
              </div>
              <p className="font-heading text-lg font-semibold">
                {t("sharing.manage.empty")}
              </p>
              <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                {t("sharing.manage.emptyHint")}
              </p>
              <div className="text-muted-foreground mt-5 flex flex-wrap justify-center gap-x-5 gap-y-2 text-xs">
                <span className="flex items-center gap-1.5">
                  <ShieldCheckIcon className="text-primary size-3.5" />
                  {t("sharing.manage.emptyOtp")}
                </span>
                <span className="flex items-center gap-1.5">
                  <FileTextIcon className="text-primary size-3.5" />
                  {t("sharing.manage.emptySnapshots")}
                </span>
              </div>
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-3">
          {shares.map((share) => {
            const status = share.status;
            const StatusIcon = statusIcons[status];
            return (
              <article
                className="border-border bg-background group hover:border-primary/25 rounded-xl border p-4 shadow-xs transition-[border-color,box-shadow] hover:shadow-sm"
                key={share.id}
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex min-w-0 flex-1 items-start gap-3.5">
                    <div className="bg-muted/60 text-muted-foreground group-hover:bg-primary/8 group-hover:text-primary flex size-11 shrink-0 items-center justify-center rounded-xl transition-colors">
                      <FileTextIcon className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <BidiText as="p" className="truncate font-semibold">
                          {share.name}
                        </BidiText>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[status]}`}
                        >
                          <StatusIcon
                            className={`size-3 ${status === "publishing" ? "animate-spin" : ""}`}
                          />
                          {t(`sharing.manage.status.${status}`)}
                        </span>
                      </div>
                      <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                        <span className="flex items-center gap-1.5">
                          <UsersIcon className="size-3.5" />
                          {t("sharing.manage.recipientCount", {
                            count: share.recipientCount,
                          })}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <FileTextIcon className="size-3.5" />
                          {t("sharing.manage.documentCount", {
                            count: share.itemCount,
                          })}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <EyeIcon className="size-3.5" />
                          {share.downloadPolicy === "allowed"
                            ? t("sharing.manage.downloadAllowed")
                            : t("folio.viewOnly")}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <CalendarClockIcon className="size-3.5" />
                          {share.expiresAt
                            ? t("sharing.manage.expires", {
                                date: formatter.dateTime(
                                  new Date(share.expiresAt),
                                  { dateStyle: "medium" },
                                ),
                              })
                            : t("sharing.manage.noExpiration")}
                        </span>
                      </div>
                      {status === "publishing" ? (
                        <div className="mt-3 max-w-sm">
                          <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                            <div className="bg-primary h-full w-2/3 animate-pulse rounded-full" />
                          </div>
                          <p className="text-muted-foreground mt-1.5 text-xs">
                            {t("sharing.manage.preparingHint")}
                          </p>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  {status !== "revoked" ? (
                    <AlertDialog>
                      <AlertDialogTrigger
                        nativeButton
                        render={
                          <Button
                            disabled={revokingId === share.id}
                            size="sm"
                            variant="ghost"
                          />
                        }
                      >
                        <Trash2Icon /> {t("sharing.manage.revoke")}
                      </AlertDialogTrigger>
                      <AlertDialogPopup>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            {t("sharing.manage.revokeTitle")}
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            {t("sharing.manage.revokeDescription", {
                              name: share.name,
                            })}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogClose render={<Button variant="ghost" />}>
                            {t("sharing.manage.cancel")}
                          </AlertDialogClose>
                          <AlertDialogClose
                            render={
                              <Button
                                loading={revokingId === share.id}
                                onClick={() =>
                                  detached(
                                    revoke(share.id),
                                    "ShareSpacesPage.revoke",
                                  )
                                }
                                variant="destructive"
                              />
                            }
                          >
                            {t("sharing.manage.revokeConfirm")}
                          </AlertDialogClose>
                        </AlertDialogFooter>
                      </AlertDialogPopup>
                    </AlertDialog>
                  ) : (
                    <span className="text-muted-foreground text-xs">
                      {share.revokedAt
                        ? t("sharing.manage.revokedOn", {
                            date: formatter.dateTime(
                              new Date(share.revokedAt),
                              { dateStyle: "medium" },
                            ),
                          })
                        : t("sharing.manage.status.revoked")}
                    </span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </main>
  );
}

const StatCard = ({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof CheckCircle2Icon;
  label: string;
  value: number;
}) => (
  <div className="border-border bg-background flex items-center gap-3 rounded-xl border p-4 shadow-xs">
    <div className="bg-primary/8 text-primary flex size-10 items-center justify-center rounded-lg">
      <Icon className="size-4.5" />
    </div>
    <div>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-muted-foreground text-xs">{label}</p>
    </div>
  </div>
);
