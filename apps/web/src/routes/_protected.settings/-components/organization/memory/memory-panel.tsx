import { useState } from "react";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Field, FieldLabel } from "@stll/ui/components/field";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { Skeleton } from "@stll/ui/components/skeleton";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@stll/ui/components/tabs";

import { usePermissions } from "@/hooks/use-permissions";
import { detached } from "@/lib/detached";
import { MemoryCreateForm } from "@/routes/_protected.settings/-components/organization/memory/memory-create-form";
import { MemoryRow } from "@/routes/_protected.settings/-components/organization/memory/memory-row";
import { SuggestionsQueue } from "@/routes/_protected.settings/-components/organization/memory/suggestions-queue";
import { memoriesOptions } from "@/routes/_protected.settings/-queries/memories";
import type {
  MemoryListItem,
  MemoryScope,
} from "@/routes/_protected.settings/-queries/memories";
import { workspacesNavigationOptions } from "@/routes/_protected.workspaces/-queries";

type MemoryTab = "mine" | "firm" | "matter";
type MemoryView = "active" | "stale" | "archived";

const TAB_TO_SCOPE = {
  mine: "user",
  firm: "organization",
  matter: "workspace",
} as const satisfies Record<MemoryTab, MemoryScope>;

export const MemoryPanel = () => {
  const t = useTranslations("memory");
  const [tab, setTab] = useState<MemoryTab>("mine");
  const canManageFirmMemory = usePermissions({ firmMemory: ["create"] });
  const canManageMatterMemory = usePermissions({ workspace: ["update"] });

  return (
    <Tabs onValueChange={setTab} value={tab}>
      <TabsList>
        <TabsTab value="mine">{t("tabs.mine")}</TabsTab>
        <TabsTab value="firm">{t("tabs.firm")}</TabsTab>
        <TabsTab value="matter">{t("tabs.matter")}</TabsTab>
      </TabsList>

      <TabsPanel value="mine">
        <MineMemories />
      </TabsPanel>
      <TabsPanel value="firm">
        <FirmMemories canManage={canManageFirmMemory} />
      </TabsPanel>
      <TabsPanel value="matter">
        <MatterMemories canManage={canManageMatterMemory} />
      </TabsPanel>
    </Tabs>
  );
};

const useActiveOrganizationId = () =>
  useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });

const MineMemories = () => {
  const activeOrganizationId = useActiveOrganizationId();

  return (
    <div className="flex flex-col gap-6 pt-4">
      <SuggestionsQueue scope="user" />
      <MemoryCreateForm scope="user" />
      <MemoryList
        scope={TAB_TO_SCOPE.mine}
        activeOrganizationId={activeOrganizationId}
        canManage={true}
      />
    </div>
  );
};

type FirmMemoriesProps = {
  canManage: boolean;
};

const FirmMemories = ({ canManage }: FirmMemoriesProps) => {
  const activeOrganizationId = useActiveOrganizationId();

  return (
    <div className="flex flex-col gap-6 pt-4">
      {canManage ? <MemoryCreateForm scope="organization" /> : null}
      <MemoryList
        scope={TAB_TO_SCOPE.firm}
        activeOrganizationId={activeOrganizationId}
        canManage={canManage}
      />
    </div>
  );
};

type MatterMemoriesProps = {
  canManage: boolean;
};

const MatterMemories = ({ canManage }: MatterMemoriesProps) => {
  const t = useTranslations("memory");
  const commonT = useTranslations("common");
  const activeOrganizationId = useActiveOrganizationId();
  const { data, isError, refetch } = useQuery(
    workspacesNavigationOptions(activeOrganizationId),
  );
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  const workspaces = data ? data.workspaces : [];

  if (isError) {
    return (
      <div className="flex items-center justify-between gap-3 py-4">
        <p className="text-destructive text-sm">
          {commonT("somethingWentWrong")}
        </p>
        <Button
          onClick={() => {
            detached(refetch(), "memory-panel.refetch");
          }}
          size="sm"
          variant="outline"
        >
          {commonT("retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 pt-4">
      <Field>
        <FieldLabel htmlFor="memory-matter-picker">
          {commonT("matter")}
        </FieldLabel>
        <Select
          onValueChange={(value) => setWorkspaceId(value || null)}
          value={workspaceId ?? ""}
        >
          <SelectTrigger className="w-full" id="memory-matter-picker">
            <SelectValue placeholder={commonT("selectAMatter")} />
          </SelectTrigger>
          <SelectPopup>
            {workspaces.map((workspace) => (
              <SelectItem key={workspace.id} value={workspace.id}>
                {workspace.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>

      {workspaceId ? (
        <>
          {canManage ? (
            <>
              <SuggestionsQueue scope="workspace" workspaceId={workspaceId} />
              <MemoryCreateForm scope="workspace" workspaceId={workspaceId} />
            </>
          ) : null}
          <MemoryList
            scope={TAB_TO_SCOPE.matter}
            workspaceId={workspaceId}
            activeOrganizationId={activeOrganizationId}
            canManage={canManage}
          />
        </>
      ) : (
        <p className="text-muted-foreground py-8 text-center text-sm">
          {t("matterPicker.empty")}
        </p>
      )}
    </div>
  );
};

type MemoryListProps = {
  activeOrganizationId: string;
  canManage: boolean;
  scope: MemoryScope;
  workspaceId?: string | undefined;
};

const MemoryList = ({
  activeOrganizationId,
  canManage,
  scope,
  workspaceId,
}: MemoryListProps) => {
  const t = useTranslations("memory");
  const commonT = useTranslations("common");
  const [view, setView] = useState<MemoryView>("active");
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPending,
    isError,
  } = useInfiniteQuery(
    memoriesOptions({
      activeOrganizationId,
      scope,
      status: view,
      ...(workspaceId !== undefined && { workspaceId }),
    }),
  );

  const items = data ? data.pages.flatMap((page) => page.items) : [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Button
          aria-pressed={view === "active"}
          onClick={() => setView("active")}
          size="sm"
          variant={view === "active" ? "secondary" : "ghost"}
        >
          {commonT("active")}
        </Button>
        <Button
          aria-pressed={view === "stale"}
          onClick={() => setView("stale")}
          size="sm"
          variant={view === "stale" ? "secondary" : "ghost"}
        >
          {commonT("stale")}
        </Button>
        <Button
          aria-pressed={view === "archived"}
          onClick={() => setView("archived")}
          size="sm"
          variant={view === "archived" ? "secondary" : "ghost"}
        >
          {t("views.archived")}
        </Button>
      </div>
      <MemoryListBody
        activeOrganizationId={activeOrganizationId}
        canManage={canManage}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isError={isError}
        isFetchingNextPage={isFetchingNextPage}
        isPending={isPending}
        items={items}
        view={view}
      />
    </div>
  );
};

type MemoryListBodyProps = {
  activeOrganizationId: string;
  canManage: boolean;
  fetchNextPage: () => Promise<unknown>;
  hasNextPage: boolean;
  isError: boolean;
  isFetchingNextPage: boolean;
  isPending: boolean;
  items: MemoryListItem[];
  view: MemoryView;
};

const MemoryListBody = ({
  activeOrganizationId,
  canManage,
  fetchNextPage,
  hasNextPage,
  isError,
  isFetchingNextPage,
  isPending,
  items,
  view,
}: MemoryListBodyProps) => {
  const t = useTranslations("memory");
  const commonT = useTranslations("common");

  if (isPending) {
    return <MemoryListSkeleton />;
  }
  if (isError) {
    return (
      <p className="text-destructive py-8 text-center text-sm">
        {commonT("somethingWentWrong")}
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <p className="text-muted-foreground py-8 text-center text-sm">
        {view === "archived" ? t("archivedEmpty") : t("empty")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map((memory) => (
        <MemoryRow
          key={memory.id}
          activeOrganizationId={activeOrganizationId}
          canManage={canManage}
          memory={memory}
        />
      ))}
      {hasNextPage ? (
        <Button
          className="self-center"
          disabled={isFetchingNextPage}
          onClick={() => {
            detached(fetchNextPage(), "memory-panel.fetch-next-page");
          }}
          size="sm"
          variant="ghost"
        >
          {isFetchingNextPage ? commonT("loading") : commonT("loadMore")}
        </Button>
      ) : null}
    </div>
  );
};

const MemoryListSkeleton = () => (
  <div className="flex flex-col gap-2">
    {[0, 1, 2].map((index) => (
      <Skeleton key={index} className="h-16 w-full" />
    ))}
  </div>
);
