import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { ScrollArea } from "@stll/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Skeleton } from "@stll/ui/skeleton";
import { TableChart } from "@stll/ui/table-chart";
import type { TableChartPoint } from "@stll/ui/table-chart";
import { TruncatedText } from "@stll/ui/truncated-text";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import Tooltip from "@/components/tooltip";
import { UserIdentityAvatar } from "@/components/user-avatar";
import { useFormattingLocale } from "@/i18n/formatting-context";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { skillMonitorOptions } from "@/lib/knowledge/queries";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

type MonitorWindowDays = 7 | 30 | 90;
const MAX_VISIBLE_AVATARS = 5;

const isMonitorWindow = (value: number): value is MonitorWindowDays =>
  value === 7 || value === 30 || value === 90;

const shortDateLabel = (isoDate: string, locale: string): string => {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return isoDate;
  }
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(parsed);
};

type SkillMonitorPanelProps = {
  skillId: string;
};

export function SkillMonitorPanel({ skillId }: SkillMonitorPanelProps) {
  const tMonitor = useTranslations("knowledge.agentSkills.monitor");
  const locale = useFormattingLocale();
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const [days, setDays] = useState<MonitorWindowDays>(7);

  const monitor = useQuery(
    skillMonitorOptions(activeOrganizationId, userId, skillId, days),
  );
  const monitorView = queryView(monitor);
  useQueryViewError(monitorView, "SkillMonitorPanel:query");

  const formatNumber = (value: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);

  const data = monitor.data;

  const trendPoints: TableChartPoint[] = data
    ? [
        ...data.dailyTrend.map((point, index) => ({
          label: shortDateLabel(point.date, locale),
          series: tMonitor("seriesRuns"),
          x: index,
          y: point.uses,
        })),
        ...data.dailyTrend.map((point, index) => ({
          label: shortDateLabel(point.date, locale),
          series: tMonitor("seriesUsers"),
          x: index,
          y: point.users,
        })),
      ]
    : [];

  const maxFileReads = data
    ? Math.max(
        1,
        data.instructionsReads,
        ...data.contextFiles.map((file) => file.reads),
      )
    : 1;

  return (
    <ScrollArea
      axis="vertical"
      className="min-h-0 flex-1"
      data-slot="skill-monitor-panel"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-6 py-5">
        <QueryViewFeedback view={monitorView} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-foreground text-sm font-semibold">
              {tMonitor("heading")}
            </h2>
            {data && (
              <p className="text-muted-foreground text-xs">
                {shortDateLabel(data.windowStart, locale)} –{" "}
                {shortDateLabel(data.windowEnd, locale)}
              </p>
            )}
          </div>
          <Select
            onValueChange={(next) => {
              const parsed = Number(next);
              if (isMonitorWindow(parsed)) {
                setDays(parsed);
              }
            }}
            value={String(days)}
          >
            <SelectTrigger
              aria-label={tMonitor("windowLabel")}
              className="w-fit min-w-36"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="7">{tMonitor("window7d")}</SelectItem>
              <SelectItem value="30">{tMonitor("window30d")}</SelectItem>
              <SelectItem value="90">{tMonitor("window90d")}</SelectItem>
            </SelectPopup>
          </Select>
        </div>

        {monitor.isLoading && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[0, 1, 2, 3].map((idx) => (
              <Skeleton className="h-20 rounded-lg" key={idx} />
            ))}
          </div>
        )}

        {data && (
          <>
            <div className="rounded-lg border p-4">
              <p className="text-muted-foreground mb-3 text-xs font-semibold tracking-wider uppercase">
                {tMonitor("overview")}
              </p>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <MetricCell
                  label={tMonitor("totalRuns")}
                  value={formatNumber(data.totalUses)}
                />
                <MetricCell
                  extra={
                    data.activeUsers.length > 0 ? (
                      <ActiveUserAvatars
                        formatNumber={formatNumber}
                        users={data.activeUsers}
                      />
                    ) : undefined
                  }
                  label={tMonitor("activeUsers")}
                  value={formatNumber(data.uniqueUsers)}
                />
                <MetricCell
                  label={tMonitor("avgDau")}
                  value={formatNumber(data.avgDailyActiveUsers)}
                />
                <MetricCell
                  detail={tMonitor("readsSplit", {
                    chat: formatNumber(data.chatReads),
                    mcp: formatNumber(data.mcpReads),
                  })}
                  label={tMonitor("totalReads")}
                  value={formatNumber(data.totalReads)}
                />
              </div>
            </div>

            <div className="rounded-lg border p-4">
              <p className="text-muted-foreground mb-3 text-xs font-semibold tracking-wider uppercase">
                {tMonitor("engagement")}
              </p>
              {data.totalReads === 0 ? (
                <p className="text-muted-foreground py-8 text-center text-sm">
                  {tMonitor("emptyActivity")}
                </p>
              ) : (
                <TableChart
                  formatNumber={formatNumber}
                  kind="line"
                  points={trendPoints}
                  summary={tMonitor("trendSummary", {
                    runs: formatNumber(data.totalUses),
                    users: formatNumber(data.uniqueUsers),
                  })}
                  title={tMonitor("useTrend")}
                  xMode="category"
                />
              )}
            </div>

            <div className="rounded-lg border p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <p className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
                  {tMonitor("contextUsage")}
                </p>
                {data.errorReads > 0 && (
                  <span className="text-destructive text-xs font-medium">
                    {tMonitor("readErrors", {
                      count: formatNumber(data.errorReads),
                    })}
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-2.5">
                <ContextUsageRow
                  errors={0}
                  label={tMonitor("instructionsLabel")}
                  maxReads={maxFileReads}
                  reads={data.instructionsReads}
                  readsLabel={formatNumber(data.instructionsReads)}
                />
                {data.contextFiles.map((file) => (
                  <ContextUsageRow
                    errors={file.errors}
                    key={file.path}
                    label={file.path}
                    maxReads={maxFileReads}
                    reads={file.reads}
                    readsLabel={formatNumber(file.reads)}
                  />
                ))}
                {data.contextFiles.length === 0 && (
                  <p className="text-muted-foreground text-xs">
                    {tMonitor("noContextFiles")}
                  </p>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </ScrollArea>
  );
}

function MetricCell({
  detail,
  extra,
  label,
  value,
}: {
  detail?: string;
  extra?: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-foreground text-xl font-semibold tabular-nums">
        {value}
      </span>
      {extra !== undefined ? <div className="mt-0.5">{extra}</div> : null}
      {detail && (
        <span className="text-muted-foreground text-xs">{detail}</span>
      )}
    </div>
  );
}

function ActiveUserAvatars({
  formatNumber,
  users,
}: {
  formatNumber: (value: number) => string;
  users: readonly {
    id: string;
    image: string | null;
    name: string | null;
    uses: number;
  }[];
}) {
  const visible = users.slice(0, MAX_VISIBLE_AVATARS);
  const overflow = users.length - visible.length;

  return (
    <div className="flex items-center -space-x-1.5">
      {visible.map((member) => {
        const displayName = member.name ?? member.id;
        return (
          <span
            className="ring-background inline-flex rounded-full ring-2"
            key={member.id}
          >
            <Tooltip
              content={`${displayName} · ${formatNumber(member.uses)}`}
              render={
                <span className="inline-flex">
                  <UserIdentityAvatar
                    className="size-6 rounded-full"
                    fallbackClassName="text-3xs"
                    image={member.image}
                    name={displayName}
                  />
                </span>
              }
            />
          </span>
        );
      })}
      {overflow > 0 && (
        <span className="bg-muted text-muted-foreground ring-background text-3xs inline-flex size-6 items-center justify-center rounded-full font-medium ring-2">
          +{overflow}
        </span>
      )}
    </div>
  );
}

function ContextUsageRow({
  errors,
  label,
  maxReads,
  reads,
  readsLabel,
}: {
  errors: number;
  label: string;
  maxReads: number;
  reads: number;
  readsLabel: string;
}) {
  const widthPct =
    reads === 0 ? 0 : Math.max(4, Math.round((reads / maxReads) * 100));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-foreground min-w-0 font-medium">
          <TruncatedText>{label}</TruncatedText>
        </span>
        <span className="text-muted-foreground shrink-0 tabular-nums">
          {readsLabel}
          {errors > 0 ? ` (${errors} err)` : ""}
        </span>
      </div>
      <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
        <div
          className="bg-primary h-full rounded-full"
          style={{ width: `${widthPct}%` }}
        />
      </div>
    </div>
  );
}
