import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { AUDIT_CHANGES_STATUS } from "@stll/api-contract/audit-log";
import { TableCell } from "@stll/ui/table";

import type { fetchAuditLogs } from "@/routes/_protected.settings/-queries/audit-logs";

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
    case AUDIT_CHANGES_STATUS.featureUnavailable:
      return (
        <TableCell className="text-muted-foreground max-w-[200px] text-xs">
          {t("common.detailsHiddenFeatureUnavailable")}
        </TableCell>
      );
    case AUDIT_CHANGES_STATUS.visible: {
      const text = changes ? JSON.stringify(changes) : "-";
      return (
        <TableCell
          className="max-w-[200px] truncate font-mono text-xs"
          title={changes ? text : ""}
        >
          <bdi>{text}</bdi>
        </TableCell>
      );
    }
    default:
      changesStatus satisfies never;
      return panic("Audit changes require a supported status");
  }
};
