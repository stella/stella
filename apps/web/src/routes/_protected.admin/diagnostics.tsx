/* eslint-disable no-untranslated-jsx-literal */
import { useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  Database as DatabaseIcon,
  Cpu as RedisIcon,
  Globe as SearchIcon,
  FolderGit2 as S3Icon,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Clock,
} from "lucide-react";

import { Button } from "@stll/ui/components/button";
import { Frame, FramePanel } from "@stll/ui/components/frame";
import { Input } from "@stll/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/components/table";
import { DatePickerPopover } from "@/components/date-picker-popover";
import { getFormattingLocale } from "@/i18n/i18n-store";
import { api } from "@/lib/api";
import {
  auditLogOptions,
  type AuditLogsPageKey,
} from "@/routes/_protected.settings/-queries/audit-logs";
import { toAuditLogDateRange } from "@/routes/_protected.settings/-queries/audit-log-date-range";

import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute("/_protected/admin/diagnostics")({
  component: AdminDiagnosticsPage,
});

const AUDIT_LOG_PAGE_LIMIT = 20;

function AdminDiagnosticsPage() {
  const [activeTab, setActiveTab] = useState<"health" | "logs">("health");

  // Audit Logs State
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);
  const [filterAction, setFilterAction] = useState<string>("");
  const [filterResourceType, setFilterResourceType] = useState<string>("");
  const [filterUserId, setFilterUserId] = useState<string>("");
  const [filterFrom, setFilterFrom] = useState<string | null>(null);
  const [filterTo, setFilterTo] = useState<string | null>(null);

  const dateRange = toAuditLogDateRange({
    from: filterFrom,
    to: filterTo,
  });

  const queryParams: AuditLogsPageKey = {
    limit: AUDIT_LOG_PAGE_LIMIT,
    cursor,
    action: filterAction || undefined,
    resourceType: filterResourceType || undefined,
    userId: filterUserId || undefined,
    from: dateRange.from,
    toExclusive: dateRange.toExclusive,
  };

  // Queries
  const diagnosticsQuery = useQuery({
    queryKey: ["admin-diagnostics"],
    queryFn: async () => {
      const response = await api.admin.diagnostics.get();
      if (response.error) {
        throw response.error;
      }
      return response.data;
    },
    refetchInterval: 30000, // Auto-refresh health every 30s
  });

  const auditLogsQuery = useQuery({
    ...auditLogOptions({ key: queryParams }),
    placeholderData: keepPreviousData,
    enabled: activeTab === "logs",
  });

  const handleFilterChange = <T,>(setter: (val: T) => void, val: T) => {
    setter(val);
    setCursor(undefined);
    setCursorHistory([]);
  };

  const handleNextPage = () => {
    if (auditLogsQuery.data?.nextCursor) {
      setCursorHistory((prev) => [...prev, cursor]);
      setCursor(auditLogsQuery.data.nextCursor);
    }
  };

  const handlePrevPage = () => {
    const prevCursor = cursorHistory.at(-1);
    setCursorHistory((prev) => prev.slice(0, -1));
    setCursor(prevCursor);
  };

  const isAnyTesting = diagnosticsQuery.isFetching;

  return (
    <div className="flex flex-col gap-6 p-6 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <SettingsPageHeader
          title="Administrative Diagnostics & Health"
          description="System health monitoring, configuration checklist, and audit logs."
        />
        {activeTab === "health" && (
          <Button
            onClick={() => void diagnosticsQuery.refetch()}
            disabled={isAnyTesting}
            variant="outline"
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${isAnyTesting ? "animate-spin" : ""}`} />
            Refresh Diagnostics
          </Button>
        )}
      </div>

      {/* Tabs Menu */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setActiveTab("health")}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === "health"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          System Health
        </button>
        <button
          onClick={() => setActiveTab("logs")}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === "logs"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Activity Logs
        </button>
      </div>

      {activeTab === "health" ? (
        <div className="flex flex-col gap-8">
          <section className="flex flex-col gap-2">
            <h2 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
              Core System Services
            </h2>
            <Frame>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[280px]">Service</TableHead>
                    <TableHead>Type / Description</TableHead>
                    <TableHead>Current Metric / Configuration</TableHead>
                    <TableHead className="w-[140px] text-end">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {/* Database */}
                  <TableRow>
                    <TableCell className="font-medium text-foreground">
                      <div className="flex items-center gap-2">
                        <DatabaseIcon className="h-4 w-4 text-muted-foreground" />
                        Database
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      PostgreSQL Relational Store
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      Latency: {diagnosticsQuery.data?.db.latencyMs ?? "-"} ms
                    </TableCell>
                    <TableCell className="text-end">
                      {diagnosticsQuery.data?.db.status === "ok" ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Healthy
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive">
                          <AlertCircle className="h-3.5 w-3.5" /> Outage
                        </span>
                      )}
                    </TableCell>
                  </TableRow>

                  {/* Redis Queue */}
                  <TableRow>
                    <TableCell className="font-medium text-foreground">
                      <div className="flex items-center gap-2">
                        <RedisIcon className="h-4 w-4 text-muted-foreground" />
                        Redis Queue
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      BullMQ Job Broker & Cache
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      Backlog Jobs: {diagnosticsQuery.data?.redis.backlogJobsCount ?? 0}
                    </TableCell>
                    <TableCell className="text-end">
                      {diagnosticsQuery.data?.redis.status === "ok" ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Connected
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive">
                          <AlertCircle className="h-3.5 w-3.5" /> Unreachable
                        </span>
                      )}
                    </TableCell>
                  </TableRow>

                  {/* S3 Storage */}
                  <TableRow>
                    <TableCell className="font-medium text-foreground">
                      <div className="flex items-center gap-2">
                        <S3Icon className="h-4 w-4 text-muted-foreground" />
                        S3 Storage
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      Document & Artifact Object Bucket
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground truncate max-w-[250px]" title={diagnosticsQuery.data?.s3.bucketName}>
                      Bucket: {diagnosticsQuery.data?.s3.bucketName ?? "-"}
                    </TableCell>
                    <TableCell className="text-end">
                      {diagnosticsQuery.data?.s3.status === "ok" ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Verified
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive">
                          <AlertCircle className="h-3.5 w-3.5" /> Error
                        </span>
                      )}
                    </TableCell>
                  </TableRow>

                  {/* Search Index */}
                  <TableRow>
                    <TableCell className="font-medium text-foreground">
                      <div className="flex items-center gap-2">
                        <SearchIcon className="h-4 w-4 text-muted-foreground" />
                        Search Index
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      Full-text Document Search Engine
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      Engine: {diagnosticsQuery.data?.searchProvider.provider ?? "-"}
                    </TableCell>
                    <TableCell className="text-end">
                      {diagnosticsQuery.data?.searchProvider.status === "ok" ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Online
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive">
                          <AlertCircle className="h-3.5 w-3.5" /> Offline
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </Frame>
          </section>

          {/* AI Providers Connectivity Details */}
          <section className="flex flex-col gap-2">
            <h2 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
              AI BYOK Integration Checks
            </h2>
            <Frame>
              <FramePanel className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <th className="p-3 text-muted-foreground text-xs font-medium">Provider Name</th>
                      <th className="p-3 text-muted-foreground text-xs font-medium text-end">Connection Status</th>
                    </TableRow>
                  </TableHeader>
                  <tbody className="divide-y divide-border">
                    {diagnosticsQuery.data?.aiAvailability.providerStatus.map((item) => (
                      <tr key={item.provider} className="hover:bg-muted/10">
                        <td className="p-3 font-semibold capitalize text-sm">{item.provider}</td>
                        <td className="p-3 text-end">
                          {item.status === "reachable" && (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
                              <CheckCircle2 className="h-3.5 w-3.5" /> Reachable
                            </span>
                          )}
                          {item.status === "unreachable" && (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive">
                              <AlertCircle className="h-3.5 w-3.5" /> Key Invalid or Blocked
                            </span>
                          )}
                          {item.status === "not_tested" && (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                              Not Configured
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {!diagnosticsQuery.data?.aiAvailability.configured && (
                      <tr>
                        <td colSpan={2} className="p-4 text-center text-muted-foreground text-xs">
                          No instance level AI provider credentials configured in settings.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </Table>
              </FramePanel>
            </Frame>
          </section>
        </div>
      ) : (
        <Frame>
          <FramePanel className="p-6">
            <div className="flex flex-col gap-6">
              {/* Filters Row */}
              <div className="bg-muted/30 grid grid-cols-1 items-end gap-2 rounded-lg border p-4 md:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-muted-foreground text-xs font-medium" htmlFor="userId-input">
                    User ID
                  </label>
                  <Input
                    id="userId-input"
                    placeholder="Filter by user ID"
                    value={filterUserId}
                    onChange={(e) => handleFilterChange(setFilterUserId, e.target.value)}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-muted-foreground text-xs font-medium" htmlFor="action-select">
                    Action
                  </label>
                  <Select
                    id="action-select"
                    value={filterAction || "all"}
                    onValueChange={(val) =>
                      handleFilterChange(setFilterAction, !val || val === "all" ? "" : val)
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="All actions" />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="all">All actions</SelectItem>
                      <SelectItem value="create">Create</SelectItem>
                      <SelectItem value="update">Update</SelectItem>
                      <SelectItem value="delete">Delete</SelectItem>
                      <SelectItem value="download">Download</SelectItem>
                      <SelectItem value="execute">Execute</SelectItem>
                      <SelectItem value="access">Access</SelectItem>
                    </SelectPopup>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-muted-foreground text-xs font-medium" htmlFor="resourceType-input">
                    Resource Type
                  </label>
                  <Input
                    id="resourceType-input"
                    placeholder="e.g. workspace"
                    value={filterResourceType}
                    onChange={(e) => handleFilterChange(setFilterResourceType, e.target.value)}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-muted-foreground text-xs font-medium" htmlFor="from-input">
                    Date From
                  </label>
                  <DatePickerPopover
                    value={filterFrom}
                    onChange={(date) => handleFilterChange(setFilterFrom, date)}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-muted-foreground text-xs font-medium" htmlFor="to-input">
                    Date To
                  </label>
                  <DatePickerPopover
                    value={filterTo}
                    onChange={(date) => handleFilterChange(setFilterTo, date)}
                  />
                </div>
              </div>

              {/* Data Table */}
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>User / Actor</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Resource Type</TableHead>
                      <TableHead>Resource ID</TableHead>
                      <TableHead>Changes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {auditLogsQuery.isLoading ? (
                      <TableRow>
                        <TableCell className="text-muted-foreground h-24 text-center" colSpan={6}>
                          Loading activity logs...
                        </TableCell>
                      </TableRow>
                    ) : auditLogsQuery.isError ? (
                      <TableRow>
                        <TableCell className="text-destructive h-24 text-center font-medium" colSpan={6}>
                          Failed to load activity logs.
                        </TableCell>
                      </TableRow>
                    ) : auditLogsQuery.data?.items.length === 0 ? (
                      <TableRow>
                        <TableCell className="text-muted-foreground h-24 text-center" colSpan={6}>
                          No activity logs found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      auditLogsQuery.data?.items.map((log) => (
                        <TableRow key={log.id}>
                          <TableCell className="text-xs whitespace-nowrap">
                            {new Date(log.createdAt).toLocaleString(getFormattingLocale())}
                          </TableCell>
                          <td className="font-mono text-xs p-3">
                            <bdi>{log.actor}</bdi>
                          </td>
                          <td className="p-3 text-xs font-semibold">{log.action}</td>
                          <td className="p-3 text-xs">{log.resourceType}</td>
                          <td className="max-w-[120px] truncate font-mono text-xs p-3" title={log.resourceId}>
                            <bdi>{log.resourceId}</bdi>
                          </td>
                          <td className="max-w-[200px] truncate font-mono text-xs p-3" title={log.changes ? JSON.stringify(log.changes) : ""}>
                            <bdi>{log.changes ? JSON.stringify(log.changes) : "-"}</bdi>
                          </td>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between px-2">
                <Button
                  disabled={cursorHistory.length === 0 || auditLogsQuery.isFetching}
                  onClick={handlePrevPage}
                  variant="outline"
                >
                  Previous
                </Button>
                <Button
                  disabled={!auditLogsQuery.data?.nextCursor || auditLogsQuery.isFetching}
                  onClick={handleNextPage}
                  variant="outline"
                >
                  Next
                </Button>
              </div>
            </div>
          </FramePanel>
        </Frame>
      )}
    </div>
  );
}
