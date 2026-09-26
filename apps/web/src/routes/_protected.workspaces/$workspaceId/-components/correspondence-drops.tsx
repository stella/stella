import { useMemo, useState } from "react";

import { useInfiniteQuery } from "@tanstack/react-query";
import {
  createColumnHelper,
  createCoreRowModel,
  flexRender,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useTranslations } from "use-intl";

import {
  Accordion,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "@stll/ui/accordion";
import { Button } from "@stll/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";

import { TableSkeletonRows } from "@/components/table-skeleton-rows";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import {
  CORRESPONDENCE_DROP_HINT_LABELS,
  CORRESPONDENCE_DROP_REASON_LABELS,
  correspondenceDropsOptions,
  type CorrespondenceDrop,
} from "@/lib/workspaces/queries/correspondence-drops";

const dropTableFeatures = tableFeatures({ coreRowModel: createCoreRowModel() });
const columnHelper = createColumnHelper<
  typeof dropTableFeatures,
  CorrespondenceDrop
>();

export const CorrespondenceDrops = ({
  workspaceId,
}: {
  workspaceId: string;
}) => {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(false);
  return (
    <Accordion onValueChange={(value) => setExpanded(value.length > 0)}>
      <AccordionItem value="drops">
        <AccordionTrigger className="min-h-11">
          {t("correspondence.drops.title")}
        </AccordionTrigger>
        <AccordionPanel>
          {expanded && <CorrespondenceDropsTable workspaceId={workspaceId} />}
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
};

const CorrespondenceDropsTable = ({ workspaceId }: { workspaceId: string }) => {
  const t = useTranslations();
  const format = useFormatter();
  const {
    data,
    isPending,
    isError,
    isFetchNextPageError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetching,
  } = useInfiniteQuery(correspondenceDropsOptions(workspaceId));
  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor("sender", {
          header: t("emailViewer.from"),
          cell: ({ getValue }) => <bdi dir="ltr">{getValue()}</bdi>,
        }),
        columnHelper.accessor("receivedAt", {
          header: t("correspondence.receivedAt"),
          cell: ({ getValue }) => (
            <time className="tabular-nums" dateTime={getValue()}>
              {format.dateTime(new Date(getValue()), {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </time>
          ),
        }),
        columnHelper.accessor("reason", {
          header: t("correspondence.drops.reason"),
          cell: ({ getValue, row }) => (
            <div className="space-y-1 whitespace-normal">
              <p>{t(CORRESPONDENCE_DROP_REASON_LABELS[getValue()])}</p>
              {row.original.setupHint !== null && (
                <p className="text-muted-foreground text-xs">
                  {t.rich(
                    CORRESPONDENCE_DROP_HINT_LABELS[row.original.setupHint],
                    { protocol: (chunks) => <bdi dir="ltr">{chunks}</bdi> },
                  )}
                </p>
              )}
            </div>
          ),
        }),
      ]),
    [format, t],
  );
  const items = useMemo(
    () => data?.pages.flatMap((page) => page.items) ?? [],
    [data],
  );
  const table = useTable({
    features: dropTableFeatures,
    data: items,
    columns,
    getRowId: (row) => row.id,
  });
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          className="min-h-11"
          disabled={isFetching}
          onClick={() => detached(refetch(), "correspondence.refresh-drops")}
          size="sm"
          variant="ghost"
        >
          {t("common.refresh")}
        </Button>
      </div>
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead key={header.id}>
                  {flexRender(
                    header.column.columnDef.header,
                    header.getContext(),
                  )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {isPending && (
            <TableSkeletonRows
              columns={table.getAllLeafColumns()}
              rowCount={3}
            />
          )}
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
          {!isPending && !isError && items.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={table.getAllLeafColumns().length}
                className="text-muted-foreground"
              >
                {t("common.noResults")}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {isError && (
        <div role="alert" className="flex items-center gap-2 text-sm">
          <span>{t("common.error")}</span>
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11"
            disabled={isFetching}
            onClick={() =>
              detached(
                isFetchNextPageError ? fetchNextPage() : refetch(),
                "correspondence.retry-drops",
              )
            }
          >
            {t("common.retry")}
          </Button>
        </div>
      )}
      {hasNextPage && !isError && (
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11"
          disabled={isFetching}
          onClick={() =>
            detached(fetchNextPage(), "correspondence.fetch-next-drops")
          }
        >
          {t("common.loadMore")}
        </Button>
      )}
    </div>
  );
};
