import { useState } from "react";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
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
import { MemoryCreateForm } from "@/routes/_protected.settings/-components/organization/memory/memory-create-form";
import { MemoryRow } from "@/routes/_protected.settings/-components/organization/memory/memory-row";
import { SuggestionsQueue } from "@/routes/_protected.settings/-components/organization/memory/suggestions-queue";
import { memoriesOptions } from "@/routes/_protected.settings/-queries/memories";
import type { MemoryScope } from "@/routes/_protected.settings/-queries/memories";
import { workspacesOptions } from "@/routes/_protected.workspaces/-queries";

type MemoryTab = "mine" | "firm" | "matter";

const TAB_TO_SCOPE = {
  mine: "user",
  firm: "organization",
  matter: "workspace",
} as const satisfies Record<MemoryTab, MemoryScope>;

export const MemoryPanel = () => {
  const t = useTranslations("memory");
  const [tab, setTab] = useState<MemoryTab>("mine");
  const canManageFirmMemory = usePermissions({ firmMemory: ["create"] });

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
        <MatterMemories />
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
      />
    </div>
  );
};

const MatterMemories = () => {
  const t = useTranslations("memory");
  const commonT = useTranslations("common");
  const activeOrganizationId = useActiveOrganizationId();
  const { data } = useQuery(workspacesOptions(activeOrganizationId));
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  const workspaces = data?.workspaces ?? [];

  return (
    <div className="flex flex-col gap-6 pt-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{commonT("matter")}</span>
        <Select
          onValueChange={(value) => setWorkspaceId(value || null)}
          value={workspaceId ?? ""}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t("matterPicker.placeholder")} />
          </SelectTrigger>
          <SelectPopup>
            {workspaces.map((workspace) => (
              <SelectItem key={workspace.id} value={workspace.id}>
                {workspace.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      {workspaceId ? (
        <>
          <SuggestionsQueue scope="workspace" workspaceId={workspaceId} />
          <MemoryCreateForm scope="workspace" workspaceId={workspaceId} />
          <MemoryList
            scope={TAB_TO_SCOPE.matter}
            workspaceId={workspaceId}
            activeOrganizationId={activeOrganizationId}
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
  scope: MemoryScope;
  workspaceId?: string | undefined;
};

const MemoryList = ({
  activeOrganizationId,
  scope,
  workspaceId,
}: MemoryListProps) => {
  const t = useTranslations("memory");
  const commonT = useTranslations("common");
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
      status: "active",
      ...(workspaceId !== undefined && { workspaceId }),
    }),
  );

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

  const items = data.pages.flatMap((page) => page.items);

  if (items.length === 0) {
    return (
      <p className="text-muted-foreground py-8 text-center text-sm">
        {t("empty")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map((memory) => (
        <MemoryRow
          key={memory.id}
          activeOrganizationId={activeOrganizationId}
          memory={memory}
        />
      ))}
      {hasNextPage ? (
        <Button
          className="self-center"
          disabled={isFetchingNextPage}
          onClick={() => {
            void fetchNextPage();
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
