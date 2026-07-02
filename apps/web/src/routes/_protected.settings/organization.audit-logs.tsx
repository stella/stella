import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Frame, FramePanel } from "@stll/ui/components/frame";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/components/table";

import { auditLogOptions } from "@/routes/_protected.settings/-queries/audit-logs";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute(
  "/_protected/settings/organization/audit-logs",
)({
  component: AuditLogsPage,
});

function AuditLogsPage() {
  const t = useTranslations();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const limit = 20;

  const queryParams: { limit: number; cursor?: string } = { limit };
  if (cursor) {
    queryParams.cursor = cursor;
  }

  const { data, isLoading } = useQuery(
    auditLogOptions(queryParams),
  );

  const handleNextPage = () => {
    if (data?.nextCursor) {
      setCursorHistory((prev) => [...prev, cursor ?? ""]);
      setCursor(data.nextCursor);
    }
  };

  const handlePrevPage = () => {
    setCursorHistory((prev) => {
      const nextHistory = [...prev];
      const prevCursor = nextHistory.pop();
      setCursor(prevCursor === "" ? undefined : prevCursor);
      return nextHistory;
    });
  };

  return (
    <>
      <SettingsPageHeader
        description={t("settings.organization.auditLogsDescription")}
        title={t("settings.organization.auditLogs")}
      />

      <Frame>
        <FramePanel>
          <div className="flex flex-col gap-4">
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Resource Type</TableHead>
                    <TableHead>Resource ID</TableHead>
                    <TableHead>Changes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow>
                      <TableCell className="text-muted-foreground h-24 text-center" colSpan={6}>
                        Loading logs...
                      </TableCell>
                    </TableRow>
                  ) : !data || data.items.length === 0 ? (
                    <TableRow>
                      <TableCell className="text-muted-foreground h-24 text-center" colSpan={6}>
                        No activity logs found.
                      </TableCell>
                    </TableRow>
                  ) : (
                    data.items.map((log) => (
                      <TableRow key={log.id}>
                        <TableCell className="whitespace-nowrap text-xs">
                          {new Date(log.createdAt).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-xs font-mono">{log.userId}</TableCell>
                        <TableCell className="text-xs capitalize font-medium">{log.action}</TableCell>
                        <TableCell className="text-xs">{log.resourceType}</TableCell>
                        <TableCell className="text-xs font-mono max-w-[120px] truncate" title={log.resourceId}>
                          {log.resourceId}
                        </TableCell>
                        <TableCell className="text-xs font-mono max-w-[200px] truncate" title={JSON.stringify(log.changes)}>
                          {log.changes ? JSON.stringify(log.changes) : "-"}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            <div className="flex justify-between items-center px-2">
              <Button
                disabled={cursorHistory.length === 0 || isLoading}
                onClick={handlePrevPage}
                variant="outline"
              >
                Previous
              </Button>
              <Button
                disabled={!data?.nextCursor || isLoading}
                onClick={handleNextPage}
                variant="outline"
              >
                Next
              </Button>
            </div>
          </div>
        </FramePanel>
      </Frame>
    </>
  );
}
