import { useMemo, type ReactNode } from "react";

import { barX, barY, defineChart } from "@tanstack/charts";
import { Chart } from "@tanstack/react-charts";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { scaleBand, scaleLinear, scaleUtc } from "d3-scale";
import { ActivityIcon, CpuIcon, UsersIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/components/bidi-text";
import { Button } from "@stll/ui/components/button";
import { Frame, FramePanel } from "@stll/ui/components/frame";
import { Skeleton } from "@stll/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/components/table";

import { InviteMemberDialog } from "@/components/organization/invite-member-dialog";
import { UserIdentity } from "@/components/user-avatar";
import { useFormatter } from "@/i18n/formatting-context";
import { organizationOptions } from "@/lib/organization/queries";
import { ensureRouteQueryData } from "@/lib/react-query";
import {
  usageOverviewOptions,
  type UsageOverviewResponse,
} from "@/lib/usage-queries";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute(
  "/_protected/settings/organization/overview",
)({
  component: OrganizationOverviewPage,
  pendingComponent: OrganizationOverviewPending,
  loader: async ({ context }) => {
    await Promise.all([
      ensureRouteQueryData(
        context.queryClient,
        usageOverviewOptions({
          organizationId: context.user.activeOrganizationId,
        }),
      ),
      ensureRouteQueryData(
        context.queryClient,
        organizationOptions(context.user.activeOrganizationId),
      ),
    ]);
  },
});

function OrganizationOverviewPage() {
  const t = useTranslations();
  const format = useFormatter();
  const organizationId = Route.useRouteContext({
    select: (context) => context.user.activeOrganizationId,
  });
  const { data } = useSuspenseQuery(usageOverviewOptions({ organizationId }));
  const { data: organization } = useSuspenseQuery(
    organizationOptions(organizationId),
  );
  const pendingInvitationCount = organization.invitations.filter(
    (invitation) => invitation.status === "pending",
  ).length;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SettingsPageHeader
          description={t("settings.organization.adminOverview.description", {
            days: format.number(data.period.days),
          })}
          title={t("settings.organization.adminOverview.title")}
        />
        <div className="flex items-center gap-2">
          <Button
            render={<Link to="/settings/organization/members" />}
            size="sm"
            variant="ghost"
          >
            {t("settings.organization.adminOverview.manageMembers")}
          </Button>
          <InviteMemberDialog
            buttonLabel={t("organization.invitations.inviteMember")}
          />
        </div>
      </div>

      <OverviewSummary data={data} />
      <ActivityTrend
        data={data}
        pendingInvitationCount={pendingInvitationCount}
      />
      <ModelUsage data={data} />
      <TopUsers data={data} />
    </>
  );
}

function OverviewSummary({ data }: { data: UsageOverviewResponse }) {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <div className="grid gap-4 md:grid-cols-[1.15fr_1fr]">
      <Frame>
        <FramePanel className="flex min-h-52 flex-col justify-between">
          <div>
            <div className="text-muted-foreground flex items-center gap-2 text-sm font-medium">
              <ActivityIcon className="size-4" />
              {t("settings.organization.adminOverview.aiActions")}
            </div>
            <div className="mt-4 text-4xl font-semibold tracking-tight tabular-nums">
              {format.number(data.summary.actions)}
            </div>
          </div>
          <p className="text-muted-foreground mt-6 text-xs leading-relaxed text-pretty">
            {t("settings.organization.adminOverview.activityTrendDescription")}
          </p>
        </FramePanel>
      </Frame>

      <Frame>
        <FramePanel className="grid h-full grid-cols-3 gap-5">
          <Metric
            icon={<UsersIcon />}
            label={t("settings.organization.adminOverview.activeUsers")}
            value={t("settings.organization.adminOverview.activeUsersValue", {
              active: format.number(data.summary.activeUsers),
              total: format.number(data.summary.totalMembers),
            })}
          />
          <Metric
            icon={<CpuIcon />}
            label={t("settings.organization.adminOverview.modelsUsed")}
            value={format.number(data.summary.modelsUsed)}
          />
          <Metric
            icon={<span className="font-mono text-[0.7rem]">§</span>}
            label={t("settings.organization.usageUnitsThisPeriod")}
            value={format.number(data.summary.units)}
          />
        </FramePanel>
      </Frame>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <span className="[&>svg]:size-3.5">{icon}</span>
        <span>{label}</span>
      </div>
      <div className="mt-2 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function ActivityTrend({
  data,
  pendingInvitationCount,
}: {
  data: UsageOverviewResponse;
  pendingInvitationCount: number;
}) {
  const t = useTranslations();
  const chartRows = useMemo(
    () =>
      fillDailySeries(data).map((day) => ({
        actions: day.actions,
        dateValue: new Date(`${day.date}T00:00:00Z`),
      })),
    [data],
  );
  const definition = useMemo(
    () =>
      defineChart<DailyChartRow, Date, number>(
        {
          marks: [
            barY(chartRows, {
              x: "dateValue",
              y: "actions",
              fill: "var(--foreground)",
              fillOpacity: 0.72,
              inset: 1,
              radius: 2,
            }),
          ],
          x: {
            scale: scaleUtc,
            nice: true,
            axis: { ticks: { count: 5 } },
          },
          y: {
            scale: scaleLinear,
            nice: true,
            grid: true,
            axis: { ticks: { count: 4 } },
          },
        },
        {},
      ),
    [chartRows],
  );

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-end justify-between gap-3 px-1">
        <div>
          <h2 className="text-sm font-medium">
            {t("settings.organization.adminOverview.activityTrend")}
          </h2>
          <p className="text-muted-foreground text-xs">
            {t("settings.organization.adminOverview.activityTrendDescription")}
          </p>
        </div>
        {pendingInvitationCount > 0 ? (
          <span className="text-muted-foreground text-xs tabular-nums">
            {t("settings.organization.adminOverview.pendingInvitations", {
              count: pendingInvitationCount,
            })}
          </span>
        ) : null}
      </div>
      <Frame>
        <FramePanel className="overflow-hidden">
          <Chart<DailyChartRow, Date, number>
            ariaDescription={t(
              "settings.organization.adminOverview.activityTrendDescription",
            )}
            ariaLabel={t("settings.organization.adminOverview.activityTrend")}
            definition={definition}
            height={190}
            initialWidth={720}
          />
        </FramePanel>
      </Frame>
    </section>
  );
}

function ModelUsage({ data }: { data: UsageOverviewResponse }) {
  const t = useTranslations();
  const format = useFormatter();
  const chartRows = useMemo(
    () =>
      data.modelUsage.map((row) => ({
        label: `${
          row.modelId ??
          t("settings.organization.adminOverview.modelRoleFallback", {
            role: row.modelRole,
          })
        } · ${row.modelRole} · ${row.isByok ? "BYOK" : "stella"}`,
        units: row.units,
      })),
    [data.modelUsage, t],
  );
  const definition = useMemo(
    () =>
      defineChart<ModelChartRow, number, string>(
        {
          marks: [
            barX(chartRows, {
              x: "units",
              y: "label",
              fill: "var(--foreground)",
              fillOpacity: 0.72,
              inset: 2,
              radius: 2,
            }),
          ],
          x: {
            scale: scaleLinear,
            nice: true,
            grid: true,
            axis: { ticks: { count: 4 } },
          },
          y: {
            scale: () => scaleBand().padding(0.12),
          },
        },
        {},
      ),
    [chartRows],
  );

  return (
    <section className="flex flex-col gap-2">
      <div className="px-1">
        <h2 className="text-sm font-medium">
          {t("settings.organization.adminOverview.modelUsage")}
        </h2>
        <p className="text-muted-foreground text-xs">
          {t("settings.organization.adminOverview.modelUsageDescription")}
        </p>
      </div>
      <Frame>
        {data.modelUsage.length > 0 ? (
          <>
            <FramePanel className="overflow-hidden border-b">
              <Chart<ModelChartRow, number, string>
                ariaDescription={t(
                  "settings.organization.adminOverview.modelUsageDescription",
                )}
                ariaLabel={t("settings.organization.adminOverview.modelUsage")}
                definition={definition}
                height={Math.max(220, chartRows.length * 38)}
                initialWidth={720}
              />
            </FramePanel>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {t("organization.aiConfig.prices.model")}
                  </TableHead>
                  <TableHead>{t("common.role")}</TableHead>
                  <TableHead>
                    {t("settings.organization.adminOverview.funding")}
                  </TableHead>
                  <TableHead className="text-end">
                    {t("common.actions")}
                  </TableHead>
                  <TableHead className="text-end">
                    {t("settings.organization.usageUnitsThisPeriod")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.modelUsage.map((row) => (
                  <TableRow
                    key={`${row.modelId ?? row.modelRole}:${row.modelRole}:${row.isByok}`}
                  >
                    <TableCell>
                      <BidiText>
                        {row.modelId ??
                          t(
                            "settings.organization.adminOverview.modelRoleFallback",
                            { role: row.modelRole },
                          )}
                      </BidiText>
                    </TableCell>
                    <TableCell>
                      <BidiText>{row.modelRole}</BidiText>
                    </TableCell>
                    <TableCell>{row.isByok ? "BYOK" : "stella"}</TableCell>
                    <TableCell className="text-end tabular-nums">
                      {format.number(row.actions)}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {format.number(row.units)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        ) : (
          <FramePanel className="text-muted-foreground py-10 text-center text-sm">
            {t("settings.organization.adminOverview.noActivity")}
          </FramePanel>
        )}
      </Frame>
    </section>
  );
}

function TopUsers({ data }: { data: UsageOverviewResponse }) {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 px-1">
        <h2 className="text-sm font-medium">
          {t("settings.organization.adminOverview.mostActiveMembers")}
        </h2>
        <Button
          render={<Link to="/settings/organization/members" />}
          size="xs"
          variant="ghost"
        >
          {t("settings.organization.adminOverview.manageMembers")}
        </Button>
      </div>
      <Frame>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("common.user")}</TableHead>
              <TableHead>{t("common.role")}</TableHead>
              <TableHead>
                {t("settings.organization.adminOverview.lastActive")}
              </TableHead>
              <TableHead className="text-end">{t("common.actions")}</TableHead>
              <TableHead className="text-end">
                {t("settings.organization.usageUnitsThisPeriod")}
              </TableHead>
              <TableHead>
                {t("settings.organization.adminOverview.modelsUsed")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.topUsers.map((activeUser) => (
              <TableRow key={activeUser.userId}>
                <TableCell>
                  <UserIdentity
                    avatarClassName="size-8 shrink-0 text-[0.625rem]"
                    name={activeUser.name}
                    secondaryText={activeUser.email}
                  />
                </TableCell>
                <TableCell>
                  <RoleLabel role={activeUser.role} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {activeUser.lastActiveAt
                    ? format.dateTime(new Date(activeUser.lastActiveAt), {
                        dateStyle: "medium",
                      })
                    : ""}
                </TableCell>
                <TableCell className="text-end tabular-nums">
                  {format.number(activeUser.actions)}
                </TableCell>
                <TableCell className="text-end tabular-nums">
                  {format.number(activeUser.units)}
                </TableCell>
                <TableCell className="text-muted-foreground max-w-56 text-xs">
                  <BidiText>{activeUser.models.join(", ")}</BidiText>
                </TableCell>
              </TableRow>
            ))}
            {data.topUsers.length === 0 ? (
              <TableRow>
                <TableCell
                  className="text-muted-foreground py-8 text-center"
                  colSpan={6}
                >
                  {t("settings.organization.adminOverview.noActivity")}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </Frame>
    </section>
  );
}

function RoleLabel({ role }: { role: string }) {
  const t = useTranslations();
  switch (role) {
    case "owner":
      return t("organization.roles.owner");
    case "admin":
      return t("organization.roles.admin");
    case "member":
      return t("organization.roles.member");
    case "intern":
      return t("organization.roles.intern");
    case "external":
      return t("organization.roles.external");
    default:
      return <BidiText>{role}</BidiText>;
  }
}

function OrganizationOverviewPending() {
  const t = useTranslations();
  return (
    <>
      <SettingsPageHeader
        title={t("settings.organization.adminOverview.title")}
      />
      <div className="grid gap-4 md:grid-cols-[1.15fr_1fr]">
        <Frame>
          <FramePanel className="min-h-52 space-y-5">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-10 w-28" />
            <Skeleton className="mt-16 h-3 w-full" />
          </FramePanel>
        </Frame>
        <Frame>
          <FramePanel className="grid h-full grid-cols-2 gap-6">
            {SKELETON_KEYS.map((key) => (
              <div className="space-y-3" key={key}>
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-7 w-16" />
              </div>
            ))}
          </FramePanel>
        </Frame>
      </div>
      <Frame>
        <FramePanel className="h-44">
          <Skeleton className="h-full w-full" />
        </FramePanel>
      </Frame>
    </>
  );
}

type DailyPoint = UsageOverviewResponse["daily"][number];
type DailyChartRow = { actions: number; dateValue: Date };
type ModelChartRow = { label: string; units: number };

const fillDailySeries = (data: UsageOverviewResponse): DailyPoint[] => {
  const byDate = new Map(data.daily.map((point) => [point.date, point]));
  const days: DailyPoint[] = [];
  const from = new Date(data.period.from);

  for (let dayIndex = 0; dayIndex < data.period.days; dayIndex++) {
    const cursor = new Date(from);
    cursor.setUTCDate(cursor.getUTCDate() + dayIndex);
    const date = cursor.toISOString().slice(0, 10);
    days.push(
      byDate.get(date) ?? {
        date,
        actions: 0,
      },
    );
  }
  return days;
};

const SKELETON_KEYS = ["a", "b", "c", "d"] as const;
