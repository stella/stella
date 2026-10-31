import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { AUDIT_CHANGES_STATUS } from "@stll/api-contract/audit-log";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";
import { cn } from "@stll/ui/utils";

import type { fetchAuditLogs } from "@/routes/_protected.admin/-queries/audit-logs";

import {
  auditChangeRows,
  formatAuditValue,
  formatAuditValueInline,
  isStructuredAuditValue,
} from "./audit-change-details.logic";
import type { AuditChangeRow } from "./audit-change-details.logic";

type AuditChangeDetailsProps = Pick<
  Awaited<ReturnType<typeof fetchAuditLogs>>["items"][number],
  "changes" | "changesStatus"
>;

/** The first change on one line, with a count of the rest. */
export const AuditChangeSummary = ({
  changes,
  changesStatus,
}: AuditChangeDetailsProps) => {
  const t = useTranslations();
  switch (changesStatus) {
    case AUDIT_CHANGES_STATUS.featureUnavailable:
      return (
        <span className="text-muted-foreground line-clamp-2">
          {t("common.detailsHiddenFeatureUnavailable")}
        </span>
      );
    case AUDIT_CHANGES_STATUS.visible: {
      const rows = auditChangeRows(changes);
      const [first] = rows;
      if (first === undefined) {
        return <span className="text-muted-foreground">-</span>;
      }
      const emptyValue = t("settings.organization.auditLogsEmptyValue");
      const inline = (value: unknown) =>
        formatAuditValueInline(value) ?? emptyValue;
      return (
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate">
            {first.field === "" ? null : (
              <span className="text-muted-foreground font-mono">
                <bdi>{first.field}</bdi>:{" "}
              </span>
            )}
            {first.type === "diff" ? (
              <>
                <bdi>{inline(first.before)}</bdi> →{" "}
                <bdi>{inline(first.after)}</bdi>
              </>
            ) : (
              <bdi>{inline(first.value)}</bdi>
            )}
          </span>
          {rows.length > 1 ? (
            <span className="text-muted-foreground shrink-0">
              {t("settings.organization.auditLogsMoreChanges", {
                count: rows.length - 1,
              })}
            </span>
          ) : null}
        </span>
      );
    }
    default:
      changesStatus satisfies never;
      return panic("Audit changes require a supported status");
  }
};

/** Every changed field with its value before and after. */
export const AuditChangeDetails = ({
  changes,
  changesStatus,
}: AuditChangeDetailsProps) => {
  const t = useTranslations();
  switch (changesStatus) {
    case AUDIT_CHANGES_STATUS.featureUnavailable:
      return (
        <p className="text-muted-foreground">
          {t("common.detailsHiddenFeatureUnavailable")}
        </p>
      );
    case AUDIT_CHANGES_STATUS.visible: {
      const rows = auditChangeRows(changes);
      if (rows.length === 0) {
        return (
          <p className="text-muted-foreground">
            {t("settings.organization.auditLogsNoChanges")}
          </p>
        );
      }
      return (
        <Table className="table-fixed" scroll="parent">
          <TableHeader>
            <TableRow>
              <TableHead className="w-1/4">
                {t("chat.toolCall.field")}
              </TableHead>
              <TableHead>
                {t("settings.organization.auditLogsBefore")}
              </TableHead>
              <TableHead>{t("settings.organization.auditLogsAfter")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <AuditChangeDetailRow key={row.field} row={row} />
            ))}
          </TableBody>
        </Table>
      );
    }
    default:
      changesStatus satisfies never;
      return panic("Audit changes require a supported status");
  }
};

// Values wrap inside their column; the shared cell keeps one line by default.
const DETAIL_CELL_CLASS = "align-top leading-normal whitespace-normal";

const AuditChangeDetailRow = ({ row }: { row: AuditChangeRow }) => (
  <TableRow>
    <TableCell className={cn(DETAIL_CELL_CLASS, "font-mono wrap-anywhere")}>
      <bdi>{row.field}</bdi>
    </TableCell>
    {row.type === "diff" ? (
      <>
        <TableCell className={DETAIL_CELL_CLASS}>
          <AuditValue value={row.before} />
        </TableCell>
        <TableCell className={DETAIL_CELL_CLASS}>
          <AuditValue value={row.after} />
        </TableCell>
      </>
    ) : (
      <TableCell className={DETAIL_CELL_CLASS} colSpan={2}>
        <AuditValue value={row.value} />
      </TableCell>
    )}
  </TableRow>
);

const AuditValue = ({ value }: { value: unknown }) => {
  const t = useTranslations();
  const text = formatAuditValue(value);
  if (text === null) {
    return (
      <span className="text-muted-foreground">
        {t("settings.organization.auditLogsEmptyValue")}
      </span>
    );
  }
  if (isStructuredAuditValue(value)) {
    return (
      <pre className="bg-muted/50 rounded-md p-2 font-mono wrap-anywhere whitespace-pre-wrap">
        <bdi>{text}</bdi>
      </pre>
    );
  }
  return (
    <span className="wrap-anywhere whitespace-pre-wrap">
      <bdi>{text}</bdi>
    </span>
  );
};
