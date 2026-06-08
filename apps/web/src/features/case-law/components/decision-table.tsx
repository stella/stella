import { useMemo } from "react";

import { Link } from "@tanstack/react-router";
import {
  createColumnHelper,
  createCoreRowModel,
  flexRender,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import type { CellContext } from "@tanstack/react-table";
import { useFormatter, useTranslations } from "use-intl";

import { createCaseLawDecisionRouteParams } from "@/lib/case-law-route";

export type Decision = {
  id: string;
  caseNumber: string;
  slug?: string | null;
  ecli: string | null;
  court: string;
  country: string;
  language: string;
  languageAlternateCount?: number | null;
  languageGroupKey?: string | null;
  decisionDate: Date | string | null;
  decisionType: string | null;
  sourceUrl: string | null;
  headline?: string | null;
  createdAt: Date | string;
};

type DecisionTableProps = {
  decisions: Decision[];
  isLoading: boolean;
};

// Static table: no optional sorting, filtering, pagination, or selection APIs.
const decisionTableFeatures = tableFeatures({});
type DecisionFeatures = typeof decisionTableFeatures;
type DecisionCellContext<TValue> = CellContext<
  DecisionFeatures,
  Decision,
  TValue
>;

const columnHelper = createColumnHelper<DecisionFeatures, Decision>();

const renderCaseNumberCell = (info: DecisionCellContext<string>) => {
  const {
    country,
    court,
    decisionDate,
    headline,
    id,
    language,
    languageAlternateCount,
    slug,
  } = info.row.original;
  const routeParams = createCaseLawDecisionRouteParams({
    caseNumber: info.getValue(),
    country,
    court,
    decisionDate,
    decisionId: id,
    language,
    languageAlternateCount,
    slug,
  });

  return (
    <div>
      {routeParams.language ? (
        <Link
          className="text-foreground font-medium hover:underline"
          params={{
            country: routeParams.country,
            court: routeParams.court,
            date: routeParams.date,
            language: routeParams.language,
            slug: routeParams.slug,
          }}
          to="/law/$country/cases/$court/$date/$language/$slug"
        >
          {info.getValue()}
        </Link>
      ) : (
        <Link
          className="text-foreground font-medium hover:underline"
          params={{
            country: routeParams.country,
            court: routeParams.court,
            date: routeParams.date,
            slug: routeParams.slug,
          }}
          to="/law/$country/cases/$court/$date/$slug"
        >
          {info.getValue()}
        </Link>
      )}
      {headline && (
        <p
          className="text-muted-foreground [&_mark]:text-foreground [&_mark]:bg-warning/30 dark:[&_mark]:bg-warning/20 mt-0.5 line-clamp-2 text-xs [&_mark]:font-medium"
          dangerouslySetInnerHTML={{ __html: headline }}
        />
      )}
    </div>
  );
};

const renderCountryCell = (info: DecisionCellContext<string>) => (
  <span className="bg-muted rounded px-1.5 py-0.5 text-xs">
    {info.getValue()}
  </span>
);

export const DecisionTable = ({ decisions, isLoading }: DecisionTableProps) => {
  const t = useTranslations();
  const format = useFormatter();

  const columns = useMemo(
    () =>
      // Preserve each column's inferred value type while returning one column array.
      columnHelper.columns([
        columnHelper.accessor("caseNumber", {
          header: t("caseLaw.columns.caseNumber"),
          cell: renderCaseNumberCell,
        }),
        columnHelper.accessor("court", {
          header: t("caseLaw.columns.court"),
        }),
        columnHelper.accessor("country", {
          header: t("common.country"),
          cell: renderCountryCell,
        }),
        columnHelper.accessor("decisionDate", {
          header: t("common.date"),
          cell: (info) => {
            const value = info.getValue();
            if (value === null) {
              return "\u2014";
            }
            const date = value instanceof Date ? value : new Date(value);
            if (Number.isNaN(date.getTime())) {
              return "\u2014";
            }
            return format.dateTime(date, {
              dateStyle: "medium",
              timeZone: "UTC",
            });
          },
        }),
        columnHelper.accessor("decisionType", {
          header: t("common.type"),
          cell: (info) => info.getValue() ?? "—",
        }),
      ]),
    [t, format],
  );

  const table = useTable({
    features: decisionTableFeatures,
    rowModels: { coreRowModel: createCoreRowModel() },
    data: decisions,
    columns,
    getRowId: (row) => row.id,
  });

  if (isLoading) {
    return (
      <p className="text-muted-foreground py-8 text-center text-sm">
        {t("caseLaw.loading")}
      </p>
    );
  }

  if (decisions.length === 0) {
    return (
      <p className="text-muted-foreground py-8 text-center text-sm">
        {t("caseLaw.emptyState")}
      </p>
    );
  }

  return (
    <div className="border-border/45 bg-background/60 overflow-hidden rounded-md border">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr
                className="border-border/45 bg-muted/35 border-b"
                key={headerGroup.id}
              >
                {headerGroup.headers.map((header) => (
                  <th
                    className="text-muted-foreground px-4 py-2 text-start font-medium"
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
                className="border-border/35 hover:bg-muted/30 border-b last:border-b-0"
                key={row.id}
              >
                {row.getAllCells().map((cell) => (
                  <td className="px-4 py-2" key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
