import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from "@stll/ui/table";

import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import {
  MEDIUM_DATE_FORMAT,
  MEDIUM_DATE_SHORT_TIME_FORMAT,
  UTC_MEDIUM_DATE_FORMAT,
} from "@/lib/relative-time";
import { workspaceOptions, workspacesKeys } from "@/lib/workspaces/queries";

export const SearchMatterPreview = ({
  workspaceId,
}: {
  workspaceId: string;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const { data, isError, isFetching, refetch } = useQuery(
    workspaceOptions(workspaceId),
  );

  if (isError) {
    return (
      <div className="flex flex-col items-start gap-3 p-5" role="alert">
        <p className="text-muted-foreground text-sm">
          {t("common.somethingWentWrong")}
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={isFetching}
          onClick={() => {
            detached(refetch(), "search-matter-preview.refetch");
          }}
        >
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  const rows = [
    { label: "common.name", value: data?.name },
    { label: "workspaces.reference", value: data?.reference },
    {
      label: "workspaces.parties.client",
      value: data
        ? (data.client?.displayName ?? t("workspaces.ownerType.personal"))
        : undefined,
    },
    {
      label: "workspaces.views.calendar.createdAt",
      value: data
        ? format.dateTime(new Date(data.createdAt), MEDIUM_DATE_FORMAT)
        : undefined,
    },
    {
      label: "workspaces.overview.recentActivity",
      value: data
        ? format.dateTime(
            new Date(data.lastActivityAt),
            MEDIUM_DATE_SHORT_TIME_FORMAT,
          )
        : undefined,
    },
  ] satisfies { label: TranslationKey; value: string | undefined }[];

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4"
      aria-busy={!data}
    >
      <MatterPreviewActivity workspaceId={workspaceId} />
      <h3 className="mb-3 text-sm font-medium">
        {t("workspaces.overview.matterDetails")}
      </h3>
      <Table className="table-fixed">
        <TableBody>
          {rows.map(({ label, value }) => (
            <TableRow className="hover:bg-transparent" key={label}>
              <TableHead
                className="w-2/5 py-3 ps-0 pe-4 align-top leading-relaxed whitespace-normal"
                scope="row"
              >
                {t(label)}
              </TableHead>
              <TableCell className="py-3 ps-0 pe-0 align-top leading-relaxed wrap-break-word whitespace-normal">
                {value === undefined ? (
                  <Skeleton className="h-5 w-3/4" />
                ) : (
                  <BidiText>{value}</BidiText>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

const MatterPreviewActivity = ({ workspaceId }: { workspaceId: string }) => {
  const t = useTranslations();
  const format = useFormatter();
  const { data, isError, isFetching, refetch } = useQuery({
    queryKey: [...workspacesKeys.byId(workspaceId), "search-preview"],
    queryFn: async ({ signal }) =>
      unwrapEden(
        await api
          .workspaces({ workspaceId })
          ["search-preview"].get({ fetch: { signal } }),
      ),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
  if (isError) {
    return (
      <div
        className="mb-5 flex items-center justify-between gap-3"
        role="alert"
      >
        <p className="text-muted-foreground text-sm">
          {t("common.somethingWentWrong")}
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={isFetching}
          onClick={() => {
            detached(refetch(), "search-matter-preview.activity-retry");
          }}
        >
          {t("common.retry")}
        </Button>
      </div>
    );
  }
  const sections = [
    {
      label: "workspaces.overview.upcomingTasks",
      empty: "search.noUpcomingDeadlines",
      items: data?.upcomingAgenda.map((item) => ({
        id: item.id,
        name: item.name,
        date: format.dateTime(new Date(item.dueDate), UTC_MEDIUM_DATE_FORMAT),
      })),
    },
    {
      label: "search.recentDocuments",
      empty: "workspaces.noDocuments",
      items: data?.recentDocuments.map((item) => ({
        id: item.id,
        name: item.name,
        date: format.dateTime(new Date(item.updatedAt), MEDIUM_DATE_FORMAT),
      })),
    },
  ] satisfies {
    label: TranslationKey;
    empty: TranslationKey;
    items: { id: string; name: string; date: string }[] | undefined;
  }[];
  return (
    <div className="mb-6 space-y-5" aria-busy={!data}>
      {sections.map(({ label, empty, items }) => (
        <section key={label}>
          <h3 className="mb-2 text-sm font-medium">{t(label)}</h3>
          {items === undefined ? (
            <Skeleton className="h-14 w-full" />
          ) : (
            <>
              {items.length === 0 && (
                <p className="text-muted-foreground text-xs">{t(empty)}</p>
              )}
              <ul className="divide-y">
                {items.map((item) => (
                  <li
                    className="flex items-baseline justify-between gap-4 py-3 text-sm"
                    key={item.id}
                  >
                    <BidiText className="min-w-0 wrap-break-word">
                      {item.name}
                    </BidiText>
                    <BidiText className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {item.date}
                    </BidiText>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ))}
    </div>
  );
};
