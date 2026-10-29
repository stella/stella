import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { AUDIT_CHANGES_STATUS } from "@stll/api-contract/audit-log";
import { TableCell } from "@stll/ui/table";

import type { fetchAuditLogs } from "@/routes/_protected.admin/-queries/audit-logs";

import { fieldLabel, isUnknownRecord } from "./audit-display-projection";

type AuditChangeDetailsProps = Pick<
  Awaited<ReturnType<typeof fetchAuditLogs>>["items"][number],
  "changes" | "changesStatus"
>;

export const AuditChangeDetails = ({
  changes,
  changesStatus,
}: AuditChangeDetailsProps) => {
  const t = useTranslations();
  switch (changesStatus) {
    case AUDIT_CHANGES_STATUS.unrecognizedResource:
      return (
        <TableCell className="text-muted-foreground max-w-[200px] text-xs">
          {t("common.detailsHiddenUnrecognizedResource")}
        </TableCell>
      );
    case AUDIT_CHANGES_STATUS.featureUnavailable:
      return (
        <TableCell className="text-muted-foreground max-w-[200px] text-xs">
          {t("common.detailsHiddenFeatureUnavailable")}
        </TableCell>
      );
    case AUDIT_CHANGES_STATUS.visible: {
      return (
        <TableCell className="max-w-[320px] text-xs">
          {changes === null ? (
            "-"
          ) : (
            <div className="space-y-2">
              <dl className="space-y-1">
                {Object.entries(toChangeRecord(changes)).map(
                  ([field, change]) => {
                    const { before, after } = beforeAndAfter(change);
                    return (
                      <div className="flex gap-2" key={field}>
                        <dt className="min-w-24 font-medium">
                          {fieldLabel(field)}
                        </dt>
                        <dd className="text-muted-foreground wrap-break-word">
                          <bdi>{displayValue(before)}</bdi>
                          <span aria-hidden="true"> → </span>
                          <bdi>{displayValue(after)}</bdi>
                        </dd>
                      </div>
                    );
                  },
                )}
              </dl>
              <details>
                <summary className="cursor-pointer font-medium select-none">
                  {t("common.details")}
                </summary>
                <pre className="mt-1 font-mono text-xs whitespace-pre-wrap">
                  <bdi>{JSON.stringify(changes, null, 2)}</bdi>
                </pre>
              </details>
            </div>
          )}
        </TableCell>
      );
    }
    default:
      changesStatus satisfies never;
      return panic("Audit changes require a supported status");
  }
};

function beforeAndAfter(change: unknown) {
  if (
    !isUnknownRecord(change) ||
    !["old", "new", "before", "after"].some((key) => Object.hasOwn(change, key))
  ) {
    return { before: null, after: change };
  }
  const before = change["before"] ?? change["old"] ?? null;
  const after = change["after"] ?? change["new"] ?? null;
  return { before, after };
}

function toChangeRecord(changes: unknown) {
  return isUnknownRecord(changes) ? changes : {};
}

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}
