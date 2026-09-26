import { Suspense } from "react";

import { useQuery, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  Outlet,
  useMatch,
} from "@tanstack/react-router";
import { CopyIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { copyToClipboard } from "@stll/clipboard";
import { Button } from "@stll/ui/button";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";
import { stellaToast } from "@stll/ui/toast";

import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import {
  correspondenceAddressOptions,
  CORRESPONDENCE_AUTH_LABEL_KEYS,
  CORRESPONDENCE_STATE_LABEL_KEYS,
  correspondenceInfiniteOptions,
} from "@/lib/workspaces/queries/correspondence";
import {
  useRevokeCorrespondenceAddress,
  useRotateCorrespondenceAddress,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/correspondence";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/correspondence",
)({ component: CorrespondencePage });

const PAGE_SIZE = 50;

function CorrespondencePage() {
  const t = useTranslations();
  const workspaceId = Route.useParams({
    select: (params) => params.workspaceId,
  });
  const detailMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/correspondence/$correspondenceId",
    shouldThrow: false,
  });

  if (detailMatch) return <Outlet />;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <h1 className="text-sm font-medium">{t("correspondence.title")}</h1>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-4">
          <AddressCard workspaceId={workspaceId} />
          <Suspense fallback={<CorrespondenceListSkeleton />}>
            <CorrespondenceList workspaceId={workspaceId} />
          </Suspense>
        </div>
      </ScrollArea>
    </div>
  );
}

const AddressCard = ({ workspaceId }: { workspaceId: string }) => {
  const t = useTranslations();
  const canUpdate = usePermissions({ workspace: ["update"] });
  const { data, isError, isPending, refetch } = useQuery(
    correspondenceAddressOptions(workspaceId),
  );
  const rotate = useRotateCorrespondenceAddress();
  const revoke = useRevokeCorrespondenceAddress();
  const address = data?.address ?? null;

  const copyAddress = async () => {
    if (!address) return;
    const copied = await copyToClipboard(address);
    if (copied) {
      stellaToast.add({ title: t("common.copied"), type: "success" });
      return;
    }
    stellaToast.add({ title: t("common.error"), type: "error" });
  };

  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
      <div className="min-w-0">
        <h2 className="text-sm font-medium">
          {t("correspondence.addressTitle")}
        </h2>
        {address ? (
          <p className="mt-1 break-all font-mono text-sm" dir="ltr">
            <bdi>{address}</bdi>
          </p>
        ) : isPending ? (
          <Skeleton className="mt-2 h-4 w-48" />
        ) : isError ? (
          <div className="mt-1 flex items-center gap-2">
            <p className="text-destructive text-sm">{t("common.error")}</p>
            <Button
              className="min-h-11"
              onClick={() =>
                detached(refetch(), "correspondence.retry-address")
              }
              size="sm"
              variant="ghost"
            >
              {t("common.retry")}
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground mt-1 text-sm">
            {t("correspondence.noAddress")}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {address && (
          <Button
            className="min-h-11"
            onClick={() =>
              detached(copyAddress(), "correspondence.copy-address")
            }
            size="sm"
            variant="outline"
          >
            <CopyIcon className="size-4" />
            {t("common.copy")}
          </Button>
        )}
        {canUpdate && (
          <Button
            className="min-h-11"
            disabled={
              rotate.isPending || revoke.isPending || isPending || isError
            }
            onClick={() => rotate.mutate({ workspaceId })}
            size="sm"
            variant="outline"
          >
            <RefreshCwIcon className="size-4" />
            {address
              ? t("correspondence.rotateAddress")
              : t("correspondence.createAddress")}
          </Button>
        )}
        {canUpdate && address && (
          <Button
            className="min-h-11"
            disabled={revoke.isPending || rotate.isPending}
            onClick={() => revoke.mutate({ workspaceId })}
            size="sm"
            variant="ghost"
          >
            <Trash2Icon className="size-4" />
            {t("correspondence.revokeAddress")}
          </Button>
        )}
      </div>
    </section>
  );
};

const CorrespondenceList = ({ workspaceId }: { workspaceId: string }) => {
  const t = useTranslations();
  const format = useFormatter();
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(
      correspondenceInfiniteOptions(workspaceId, PAGE_SIZE),
    );
  const items = data.pages.flatMap((page) => page.items);

  if (items.length === 0) {
    return (
      <p className="text-muted-foreground py-12 text-center text-sm">
        {t("correspondence.empty")}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-lg border">
        {items.map((item) => (
          <Link
            className="hover:bg-muted/40 flex min-h-16 items-center gap-4 border-b px-4 py-3 last:border-0"
            key={item.id}
            params={{ workspaceId, correspondenceId: item.id }}
            to="/workspaces/$workspaceId/correspondence/$correspondenceId"
          >
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate text-sm font-medium">
                  <bdi dir="auto">
                    {item.subject || t("correspondence.noSubject")}
                  </bdi>
                </span>
                <span className="text-muted-foreground text-xs">
                  {t(CORRESPONDENCE_STATE_LABEL_KEYS[item.handlingState])}
                </span>
              </span>
              <span className="text-muted-foreground mt-1 block truncate text-xs">
                {t("correspondence.fromLabel")}:{" "}
                <bdi dir="auto">{item.from.name ?? item.from.address}</bdi>
              </span>
              <span className="text-muted-foreground mt-1 block truncate text-xs">
                {t("correspondence.toLabel")}:{" "}
                {item.to.map((recipient, index) => (
                  <bdi
                    className="me-2"
                    dir="auto"
                    key={`${recipient.address}-${index}`}
                  >
                    {recipient.name ?? recipient.address}
                  </bdi>
                ))}
              </span>
            </span>
            <span className="text-muted-foreground shrink-0 text-xs">
              DMARC:{" "}
              {t(CORRESPONDENCE_AUTH_LABEL_KEYS[item.authentication.dmarc])}
            </span>
            <time className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {format.dateTime(new Date(item.receivedAt), {
                dateStyle: "medium",
              })}
            </time>
          </Link>
        ))}
      </div>
      {hasNextPage && (
        <div className="flex justify-center">
          <Button
            className="min-h-11"
            disabled={isFetchingNextPage}
            onClick={() =>
              detached(fetchNextPage(), "correspondence.fetch-next-page")
            }
            size="sm"
            variant="ghost"
          >
            {t("common.loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
};

const CorrespondenceListSkeleton = () => (
  <div className="space-y-2">
    {Array.from({ length: 5 }, (_, index) => (
      <div
        className="flex h-16 items-center gap-4 rounded-lg border px-4"
        key={index}
      >
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-3 w-36" />
        </div>
        <Skeleton className="h-3 w-20" />
      </div>
    ))}
  </div>
);
