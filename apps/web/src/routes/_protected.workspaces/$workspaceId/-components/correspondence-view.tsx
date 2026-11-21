import { Suspense } from "react";

import { useQuery, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import type { DataBoxDirectionBasis } from "@stll/api-contract/data-box";
import { Button } from "@stll/ui/button";
import { RefreshCwIcon, Trash2Icon } from "@stll/ui/icons";
import { Skeleton } from "@stll/ui/skeleton";
import { TruncatedText } from "@stll/ui/truncated-text";

import { CopyControl } from "@/components/copy-control";
import { DATA_BOX_DIRECTION_LABEL_KEYS } from "@/features/correspondence/data-box-direction";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import {
  CORRESPONDENCE_PAGE_SIZE,
  CORRESPONDENCE_STATE_LABEL_KEYS,
  correspondenceAddressOptions,
  correspondenceInfiniteOptions,
  uniqueCorrespondenceAddresses,
} from "@/lib/workspaces/queries/correspondence";
import { CorrespondenceDrops } from "@/routes/_protected.workspaces/$workspaceId/-components/correspondence-drops";
import {
  AssertedHeadersLabel,
  CorrespondenceProvenance,
} from "@/routes/_protected.workspaces/$workspaceId/-components/correspondence-provenance";
import { correspondenceProvenancePresentation } from "@/routes/_protected.workspaces/$workspaceId/-components/correspondence-provenance.logic";
import { CorrespondenceListSkeleton } from "@/routes/_protected.workspaces/$workspaceId/-components/correspondence-view.pending";
import {
  useRevokeCorrespondenceAddress,
  useRotateCorrespondenceAddress,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/correspondence";

const DataBoxDirectionLabel = ({ basis }: { basis: DataBoxDirectionBasis }) => {
  const t = useTranslations();
  const label = DATA_BOX_DIRECTION_LABEL_KEYS[basis];
  return label === null ? null : (
    <span className="text-muted-foreground text-xs">{t(label)}</span>
  );
};

/**
 * Body of a matter's correspondence view: the matter's inbound address, the
 * messages that could not be filed, and the messages filed to it. Each
 * message opens its own page.
 */
export const CorrespondenceView = ({
  workspaceId,
}: {
  workspaceId: string;
}) => {
  const t = useTranslations();
  return (
    <div className="space-y-5 p-4 sm:p-6">
      <h1 className="sr-only">{t("correspondence.title")}</h1>
      <AddressCard workspaceId={workspaceId} />
      <CorrespondenceDrops workspaceId={workspaceId} />
      <Suspense fallback={<CorrespondenceListSkeleton />}>
        <CorrespondenceList workspaceId={workspaceId} />
      </Suspense>
    </div>
  );
};

/** Route-pending body: the address card and the list rows, shimmering. */
const AddressCard = ({ workspaceId }: { workspaceId: string }) => {
  const t = useTranslations();
  const canUpdate = usePermissions({ workspace: ["update"] });
  const { data, isError, isPending, refetch } = useQuery(
    correspondenceAddressOptions(workspaceId),
  );
  const rotate = useRotateCorrespondenceAddress();
  const revoke = useRevokeCorrespondenceAddress();
  const address = data?.status === "configured" ? data.address : null;

  let addressStatus = (
    <p className="text-muted-foreground mt-1 text-sm">
      {t(
        data?.status === "unconfigured"
          ? "correspondence.inboundNotConfigured"
          : "correspondence.noAddress",
      )}
    </p>
  );
  if (address) {
    addressStatus = (
      <p className="mt-1 font-mono text-sm break-all" dir="ltr">
        <bdi>{address}</bdi>
      </p>
    );
  } else if (isPending) {
    addressStatus = <Skeleton className="mt-2 h-4 w-48" />;
  } else if (isError) {
    addressStatus = (
      <div className="mt-1 flex items-center gap-2">
        <p className="text-destructive text-sm">
          {t("common.somethingWentWrong")}
        </p>
        <Button
          className="min-h-11"
          onClick={() => detached(refetch(), "correspondence.retry-address")}
          size="sm"
          variant="ghost"
        >
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  const resolveAddressChangeDisabledReason = () => {
    if (rotate.isPending || revoke.isPending) {
      return t("common.saving");
    }
    if (isPending) {
      return t("common.loading");
    }
    if (isError) {
      return t("common.loadFailed");
    }
    return t("correspondence.addressNotConfigured");
  };

  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
      <div className="min-w-0">
        <h2 className="text-sm font-medium">
          {t("correspondence.addressTitle")}
        </h2>
        {addressStatus}
      </div>
      <div className="flex flex-wrap gap-2">
        {address && (
          <CopyControl
            className="min-h-11"
            iconClassName="size-4"
            size="sm"
            text={address}
            variant="outline"
          />
        )}
        {canUpdate && (
          <Button
            className="min-h-11"
            disabled={
              rotate.isPending ||
              revoke.isPending ||
              isPending ||
              isError ||
              data.status === "unconfigured"
            }
            disabledReason={resolveAddressChangeDisabledReason()}
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
            disabledReason={t("common.saving")}
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
      correspondenceInfiniteOptions(workspaceId, CORRESPONDENCE_PAGE_SIZE),
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
              <CorrespondenceProvenance record={item} />
              <span className="mt-2 block">
                {item.channel === "email" && (
                  <AssertedHeadersLabel record={item} />
                )}
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <TruncatedText className="text-sm font-medium">
                    <bdi dir="auto">
                      {item.subject || t("emailViewer.noSubject")}
                    </bdi>
                  </TruncatedText>
                  <span className="text-muted-foreground text-xs">
                    {t(CORRESPONDENCE_STATE_LABEL_KEYS[item.handlingState])}
                  </span>
                  {item.channel === "data_box" && (
                    <span className="bg-muted text-muted-foreground rounded-full px-1.5 text-xs">
                      {t("correspondence.dataBox.channel")}
                    </span>
                  )}
                  {item.channel === "data_box" && (
                    <DataBoxDirectionLabel
                      basis={item.dataBox.directionBasis}
                    />
                  )}
                </span>
                {item.channel === "data_box" ? (
                  <TruncatedText className="text-muted-foreground mt-1 text-xs">
                    {t("emailViewer.from")}:{" "}
                    {item.from.name && (
                      <bdi className="me-1" dir="auto">
                        {item.from.name}
                      </bdi>
                    )}
                    <bdi className="font-mono" dir="ltr">
                      {item.from.address}
                    </bdi>
                  </TruncatedText>
                ) : (
                  <TruncatedText className="text-muted-foreground mt-1 text-xs">
                    {t(
                      correspondenceProvenancePresentation(item)
                        .originalSenderLabel,
                    )}
                    : <bdi dir="ltr">{item.from.address}</bdi>
                  </TruncatedText>
                )}
                <TruncatedText className="text-muted-foreground mt-1 text-xs">
                  {t("emailViewer.to")}:{" "}
                  {uniqueCorrespondenceAddresses(item.to).map((recipient) => (
                    <bdi
                      className="me-2"
                      dir="auto"
                      key={recipient.address.toLowerCase()}
                    >
                      {recipient.name ?? recipient.address}
                    </bdi>
                  ))}
                </TruncatedText>
              </span>
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
            disabledReason={t("common.loading")}
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
