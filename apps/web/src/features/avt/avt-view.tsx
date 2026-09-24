/**
 * The AVT view of a matter: the list whose facts documents are checked
 * against, the matter's documents with their latest verification, and the
 * list's anchor facts. Opening a verification replaces the home with it.
 */

import * as React from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Skeleton } from "@stll/ui/skeleton";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@stll/ui/tabs";
import { stellaToast } from "@stll/ui/toast";

import { AnchorFactsPanel } from "@/features/avt/anchor-facts-panel";
import { DocumentVerifications } from "@/features/avt/document-verifications";
import { VerificationDetail } from "@/features/avt/verification-detail";
import { usePermissions } from "@/hooks/use-permissions";
import { toSafeId } from "@/lib/safe-id";
import { legalListsOptions } from "@/lib/workspaces/queries/legal-lists";
import type { AvtWorkspaceView } from "@/lib/workspaces/view-layout";
import { mergeLayout } from "@/lib/workspaces/view-layout";
import { useUpdateView } from "@/routes/_protected.workspaces/$workspaceId/-mutations/views";

type AvtViewProps = {
  view: AvtWorkspaceView;
  workspaceId: string;
  runId: string | undefined;
  onRunChange: (runId: string | undefined) => void;
};

export const AvtView = ({
  view,
  workspaceId,
  runId,
  onRunChange,
}: AvtViewProps) => {
  const t = useTranslations();
  const listId = view.layout.listId;

  if (runId !== undefined) {
    return (
      <div className="flex flex-col gap-4 p-4 md:h-full">
        <VerificationDetail
          key={runId}
          listId={listId}
          onBack={() => onRunChange(undefined)}
          onOpenRun={onRunChange}
          runId={runId}
          workspaceId={workspaceId}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <EvidenceListPicker view={view} workspaceId={workspaceId} />
      {listId === null ? (
        <p className="text-muted-foreground text-sm">
          {t("avt.view.pickList")}
        </p>
      ) : (
        <Tabs defaultValue="documents">
          <TabsList>
            <TabsTab value="documents">{t("common.documents")}</TabsTab>
            <TabsTab value="facts">{t("avt.anchorFacts.title")}</TabsTab>
          </TabsList>
          <TabsPanel value="documents">
            <div className="pt-4">
              <React.Suspense fallback={<RowsSkeleton />}>
                <DocumentVerifications
                  listId={listId}
                  onOpenRun={onRunChange}
                  workspaceId={workspaceId}
                />
              </React.Suspense>
            </div>
          </TabsPanel>
          <TabsPanel value="facts">
            <div className="pt-4">
              <React.Suspense fallback={<RowsSkeleton />}>
                <AnchorFactsPanel listId={listId} workspaceId={workspaceId} />
              </React.Suspense>
            </div>
          </TabsPanel>
        </Tabs>
      )}
    </div>
  );
};

const EvidenceListPicker = ({
  view,
  workspaceId,
}: {
  view: AvtWorkspaceView;
  workspaceId: string;
}) => {
  const t = useTranslations();
  const canUpdateView = usePermissions({ view: ["update"] });
  const updateView = useUpdateView(workspaceId);
  const { data: lists } = useQuery(legalListsOptions(workspaceId));
  const items = lists?.items ?? [];

  const pick = (listId: string) => {
    updateView.mutate(
      {
        viewId: view.id,
        layout: mergeLayout(view.layout, {
          listId: toSafeId<"legalList">(listId),
        }),
      },
      {
        onError: () => {
          stellaToast.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground text-sm">
        {t("avt.view.evidenceList")}
      </span>
      <Select
        disabled={!canUpdateView || items.length === 0}
        onValueChange={(next) => {
          if (next !== null && next !== view.layout.listId) {
            pick(next);
          }
        }}
        value={view.layout.listId}
      >
        <SelectTrigger aria-label={t("avt.view.evidenceList")} size="sm">
          <SelectValue
            placeholder={
              items.length === 0
                ? t("avt.view.noLists")
                : t("avt.view.chooseList")
            }
          />
        </SelectTrigger>
        <SelectPopup>
          {items.map((list) => (
            <SelectItem key={list.id} value={list.id}>
              {list.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
};

const ROW_KEYS = ["a", "b", "c", "d"];

const RowsSkeleton = () => (
  <div className="flex flex-col gap-2">
    {ROW_KEYS.map((key) => (
      <Skeleton className="h-12 w-full" key={key} />
    ))}
  </div>
);
