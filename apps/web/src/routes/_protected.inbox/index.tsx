import { useState } from "react";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { InboxIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { SIGNAL_ORIGINS, SIGNAL_SEVERITIES } from "@stll/api-contract/signals";
import { UserText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@stll/ui/menu";
import { Skeleton } from "@stll/ui/skeleton";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import "@/features/inbox/signal-inspector-registration";
import { env } from "@/env";
import { MyWorkView } from "@/features/inbox/components/my-work-view";
import {
  ORIGIN_LABEL_KEY,
  SEVERITY_LABEL_KEY,
} from "@/features/inbox/signal-presentation";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { groupInboxDays } from "@/lib/inbox/inbox.logic";
import {
  DEFAULT_INBOX_FILTERS,
  INBOX_VIEWS,
  inboxSignalsOptions,
} from "@/lib/inbox/queries";
import type { InboxFilters, InboxView } from "@/lib/inbox/queries";
import { localISODate } from "@/lib/local-iso-date";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteInfiniteQueryData } from "@/lib/react-query";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";
import { myWorkOptions } from "@/lib/workspaces/queries/my-work";
import { NewRequestDialog } from "@/routes/_protected.inbox/-new-request-dialog";
import { SignalCard } from "@/routes/_protected.inbox/-signal-card";

const protectedRouteApi = getRouteApi("/_protected");

export const Route = createFileRoute("/_protected/inbox/")({
  loader: async ({ context }) => {
    // Governed queues only exist behind the deployment flag; prefetching
    // them on a flag-off deployment would fail the whole route load.
    await Promise.all([
      ensureRouteInfiniteQueryData(
        context.queryClient,
        inboxSignalsOptions(
          context.user.activeOrganizationId,
          DEFAULT_INBOX_FILTERS,
        ),
      ),
      ...(env.VITE_FEATURE_GOVERNED_WORKFLOW
        ? [
            ensureRouteInfiniteQueryData(
              context.queryClient,
              myWorkOptions("to_acknowledge", localISODate()),
            ),
          ]
        : []),
    ]);
  },
  head: () => ({
    meta: [{ title: pageTitle("navigation.inbox") }],
  }),
  pendingComponent: InboxPending,
  component: InboxPage,
});

const VIEW_LABEL_KEY = {
  open: "common.open",
  snoozed: "inbox.view.snoozed",
  resolved: "inbox.view.resolved",
} as const satisfies Record<InboxView, TranslationKey>;

const INBOX_SECTION = {
  NEW: "new",
  MY_WORK: "my-work",
} as const;
type InboxSection = (typeof INBOX_SECTION)[keyof typeof INBOX_SECTION];

function InboxPage() {
  const t = useTranslations();
  const format = useFormatter();
  const analytics = useAnalytics();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const [section, setSection] = useState<InboxSection>(INBOX_SECTION.NEW);
  const [filters, setFilters] = useState<InboxFilters>(DEFAULT_INBOX_FILTERS);
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPending,
    refetch,
  } = useInfiniteQuery(inboxSignalsOptions(activeOrganizationId, filters));
  const { data: workspacesData } = useQuery(
    workspacesNavigationOptions(activeOrganizationId),
  );

  useExternalSyncEffect(() => {
    if (!error) {
      return;
    }
    analytics.captureError(error);
    stellaToast.error(userErrorFromThrown(error, t("common.unexpectedError")));
  }, [analytics, error, t]);

  const signals = data ? data.pages.flatMap((page) => page.items) : [];
  const days = groupInboxDays(signals);
  const workspaces = workspacesData ? workspacesData.workspaces : [];
  const selectedWorkspaceName =
    filters.workspaceId === null
      ? null
      : (workspaces.find((w) => w.id === filters.workspaceId)?.name ?? null);

  const update = (patch: Partial<InboxFilters>) =>
    setFilters((previous) => ({ ...previous, ...patch }));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto border-t">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
        <header className="flex flex-wrap items-center gap-2">
          <h1 className="me-auto text-lg font-semibold">
            {t("navigation.inbox")}
          </h1>
          <NewRequestDialog organizationId={activeOrganizationId} />
        </header>

        {env.VITE_FEATURE_GOVERNED_WORKFLOW ? (
          <div className="flex gap-1 border-b pb-3">
            <Button
              aria-pressed={section === INBOX_SECTION.NEW}
              onClick={() => setSection(INBOX_SECTION.NEW)}
              size="sm"
              variant={section === INBOX_SECTION.NEW ? "default" : "outline"}
            >
              {t("inbox.view.new")}
            </Button>
            <Button
              aria-pressed={section === INBOX_SECTION.MY_WORK}
              onClick={() => setSection(INBOX_SECTION.MY_WORK)}
              size="sm"
              variant={
                section === INBOX_SECTION.MY_WORK ? "default" : "outline"
              }
            >
              {t("tasks.myWorkTitle")}
            </Button>
          </div>
        ) : null}

        {section === INBOX_SECTION.MY_WORK ? (
          <MyWorkView organizationId={activeOrganizationId} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="flex gap-1">
                {INBOX_VIEWS.map((view) => (
                  <Button
                    aria-pressed={filters.view === view}
                    key={view}
                    onClick={() => update({ view })}
                    size="sm"
                    variant={filters.view === view ? "default" : "outline"}
                  >
                    {t(VIEW_LABEL_KEY[view])}
                  </Button>
                ))}
              </div>
              <span className="flex-1" />
              <Button
                aria-pressed={filters.assignedToMe}
                onClick={() => update({ assignedToMe: !filters.assignedToMe })}
                size="sm"
                variant={filters.assignedToMe ? "default" : "ghost"}
              >
                {t("inbox.filter.mine")}
              </Button>
              <Menu>
                <MenuTrigger render={<Button size="sm" variant="ghost" />}>
                  {selectedWorkspaceName === null ? (
                    t("inspector.matterPicker.allMatters")
                  ) : (
                    <UserText>{selectedWorkspaceName}</UserText>
                  )}
                </MenuTrigger>
                <MenuPopup>
                  <MenuRadioGroup
                    onValueChange={(value) => {
                      // The radio group hands back an unknown-typed value.
                      if (typeof value !== "string") {
                        return;
                      }
                      update({ workspaceId: value === "" ? null : value });
                    }}
                    value={filters.workspaceId ?? ""}
                  >
                    <MenuRadioItem value="">
                      {t("inspector.matterPicker.allMatters")}
                    </MenuRadioItem>
                    {workspaces.map((workspace) => (
                      <MenuRadioItem key={workspace.id} value={workspace.id}>
                        <UserText>{workspace.name}</UserText>
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuPopup>
              </Menu>
              <Menu>
                <MenuTrigger render={<Button size="sm" variant="ghost" />}>
                  {filters.origin === null
                    ? t("workspaces.overview.activity.list.provenance")
                    : t(ORIGIN_LABEL_KEY[filters.origin])}
                </MenuTrigger>
                <MenuPopup>
                  <MenuItem onClick={() => update({ origin: null })}>
                    {t("inbox.filter.any")}
                  </MenuItem>
                  {SIGNAL_ORIGINS.map((origin) => (
                    <MenuItem key={origin} onClick={() => update({ origin })}>
                      {t(ORIGIN_LABEL_KEY[origin])}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
              <Menu>
                <MenuTrigger render={<Button size="sm" variant="ghost" />}>
                  {filters.severity === null
                    ? t("knowledge.playbooks.severityLabel")
                    : t(SEVERITY_LABEL_KEY[filters.severity])}
                </MenuTrigger>
                <MenuPopup>
                  <MenuItem onClick={() => update({ severity: null })}>
                    {t("inbox.filter.any")}
                  </MenuItem>
                  {SIGNAL_SEVERITIES.map((severity) => (
                    <MenuItem
                      key={severity}
                      onClick={() => update({ severity })}
                    >
                      {t(SEVERITY_LABEL_KEY[severity])}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            </div>

            {isPending && <FeedSkeleton />}

            {!isPending && error && (
              <div className="text-muted-foreground flex flex-col items-center gap-3 py-16 text-sm">
                <InboxIcon className="size-8 opacity-40" />
                <p>{userErrorFromThrown(error, t("common.unexpectedError"))}</p>
                <Button
                  onClick={() => {
                    detached(refetch(), "inbox.retry-feed");
                  }}
                  size="sm"
                  variant="outline"
                >
                  {t("common.retry")}
                </Button>
              </div>
            )}

            {!isPending && !error && days.length === 0 && (
              <div className="text-muted-foreground flex flex-col items-center gap-2 py-16 text-sm">
                <InboxIcon className="size-8 opacity-40" />
                <p>{t("inbox.empty")}</p>
              </div>
            )}

            {!error &&
              days.map((day) => (
                <section className="flex flex-col gap-2" key={day.key}>
                  <h2 className="text-muted-foreground px-1 text-xs font-medium">
                    {format.dateTime(new Date(day.at), { dateStyle: "full" })}
                  </h2>
                  <div className="flex flex-col gap-2">
                    {day.items.map((signal) => (
                      <SignalCard
                        key={signal.id}
                        organizationId={activeOrganizationId}
                        signal={signal}
                      />
                    ))}
                  </div>
                </section>
              ))}

            {!error && hasNextPage && (
              <Button
                className="self-center"
                disabled={isFetchingNextPage}
                onClick={() => {
                  detached(fetchNextPage(), "inbox.fetch-next-page");
                }}
                size="sm"
                variant="outline"
              >
                {isFetchingNextPage
                  ? t("common.loading")
                  : t("common.loadMore")}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const SKELETON_DAY_KEYS = ["alpha", "beta"];
const SKELETON_CARD_KEYS = ["one", "two", "three"];
const SKELETON_TITLE_WIDTHS: Record<string, string> = {
  one: "w-64",
  two: "w-80",
  three: "w-52",
};

// Mirrors the loaded feed (day heading + cards) so only values fade in.
const FeedSkeleton = () => (
  <>
    {SKELETON_DAY_KEYS.map((dayKey) => (
      <section className="flex flex-col gap-2" key={dayKey}>
        <Skeleton className="mx-1 h-3 w-40" />
        <div className="flex flex-col gap-2">
          {SKELETON_CARD_KEYS.map((cardKey) => (
            <div
              className="bg-card flex flex-col gap-2 rounded-lg p-3 shadow-xs"
              key={`${dayKey}-${cardKey}`}
            >
              <div className="flex items-start gap-3">
                <Skeleton className="mt-1.5 size-2 shrink-0 rounded-full" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton
                    className={cn("h-4", SKELETON_TITLE_WIDTHS[cardKey])}
                  />
                  <Skeleton className="h-3.5 w-full" />
                  <Skeleton className="h-3 w-48" />
                </div>
              </div>
              <div className="flex gap-1.5 ps-5">
                <Skeleton className="h-7 w-24 rounded-md" />
                <Skeleton className="h-7 w-20 rounded-md" />
              </div>
            </div>
          ))}
        </div>
      </section>
    ))}
  </>
);

function InboxPending() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto border-t">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
        <header className="flex items-center gap-2">
          <Skeleton className="me-auto h-6 w-24" />
          <Skeleton className="h-8 w-28 rounded-md" />
        </header>
        <div className="flex gap-1">
          <Skeleton className="h-8 w-16 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-md" />
        </div>
        <FeedSkeleton />
      </div>
    </div>
  );
}
