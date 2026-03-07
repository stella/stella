import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useTranslations } from "use-intl";

export type Decision = {
  id: string;
  caseNumber: string;
  ecli: string | null;
  court: string;
  country: string;
  language: string;
  decisionDate: string | null;
  decisionType: string | null;
  sourceUrl: string | null;
  headline?: string | null;
  createdAt: Date;
};

type DecisionTableProps = {
  decisions: Decision[];
  isLoading: boolean;
};

const columnHelper = createColumnHelper<Decision>();

export const DecisionTable = ({ decisions, isLoading }: DecisionTableProps) => {
  const t = useTranslations();

  const columns = useMemo(
    () => [
      columnHelper.accessor("caseNumber", {
        header: t("caseLaw.columns.caseNumber"),
        cell: (info) => {
          const { id, headline } = info.row.original;
          return (
            <div>
              <Link
                className="font-medium text-foreground hover:underline"
                params={{ decisionId: id }}
                to="/knowledge/case-law/$decisionId"
              >
                {info.getValue()}
              </Link>
              {headline && (
                <p
                  className="mt-0.5 line-clamp-2 text-xs text-muted-foreground [&_mark]:bg-yellow-200/50 [&_mark]:font-medium [&_mark]:text-foreground dark:[&_mark]:bg-yellow-500/20"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: headline is escaped server-side (escapeAndHighlight) and only contains <mark> tags
                  dangerouslySetInnerHTML={{ __html: headline }}
                />
              )}
            </div>
          );
        },
      }),
      columnHelper.accessor("court", {
        header: t("caseLaw.columns.court"),
      }),
      columnHelper.accessor("country", {
        header: t("caseLaw.columns.country"),
        cell: (info) => (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
            {info.getValue()}
          </span>
        ),
      }),
      columnHelper.accessor("decisionDate", {
        header: t("caseLaw.columns.decisionDate"),
        cell: (info) => {
          const value = info.getValue();
          return value ?? "—";
        },
      }),
      columnHelper.accessor("decisionType", {
        header: t("caseLaw.columns.decisionType"),
        cell: (info) => info.getValue() ?? "—",
      }),
    ],
    [t],
  );

  const table = useReactTable({
    data: decisions,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
    sortingFns: {
      sortProperty: () => 0,
    },
  });

  if (isLoading) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {t("caseLaw.loading")}
      </p>
    );
  }

  if (decisions.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {t("caseLaw.emptyState")}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr className="border-b bg-muted/50" key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th
                  className="px-4 py-2 text-left font-medium text-muted-foreground"
                  key={header.id}
                >
                  {flexRender(
                    header.column.columnDef.header,
                    header.getContext(),
                  )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              className="border-b last:border-b-0 hover:bg-muted/30"
              key={row.id}
            >
              {row.getVisibleCells().map((cell) => (
                <td className="px-4 py-2" key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
