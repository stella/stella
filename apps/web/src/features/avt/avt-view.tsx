import * as React from "react";
/**
 * The AVT view of a matter: the list whose facts documents are checked
 * against, the matter's documents with their latest verification, and the
 * list's anchor facts. Opening a verification replaces the home with it.
 */

import { useSuspenseQuery } from "@tanstack/react-query";
import { panic } from "better-result";
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
import { ToggleGroup, ToggleGroupItem } from "@stll/ui/toggle-group";

import { AnchorFactsPanel } from "@/features/avt/anchor-facts-panel";
import type { AvtMode } from "@/features/avt/avt-mode";
import { DocumentVerifications } from "@/features/avt/document-verifications";
import { EvidenceListEmptyState } from "@/features/avt/evidence-list-empty-state";
import { Chronology } from "@/features/avt/graph/chronology";
import { VerificationGraph } from "@/features/avt/graph/verification-graph";
import { LoadSampleCaseButton } from "@/features/avt/load-sample-case-button";
import { VerificationDetail } from "@/features/avt/verification-detail";
import { usePermissions } from "@/hooks/use-permissions";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";
import { useUpdateView } from "@/lib/workspaces/mutations/views";
import { legalListsOptions } from "@/lib/workspaces/queries/legal-lists";
import type { AvtWorkspaceView } from "@/lib/workspaces/view-layout";
import { mergeLayout } from "@/lib/workspaces/view-layout";

type AvtViewProps = {
  view: AvtWorkspaceView;
  workspaceId: string;
  runId: string | undefined;
  onRunChange: (runId: string | undefined) => void;
  /** How the list is shown: the review when undefined. */
  mode: AvtMode | undefined;
  onModeChange: (mode: AvtMode | undefined) => void;
};

export const AvtView = ({
  view,
  workspaceId,
  runId,
  onRunChange,
  mode,
  onModeChange,
}: AvtViewProps) => {
  const t = useTranslations();
  const listId = view.layout.listId;
  // The view's loader has already read the workspace's lists.
  const {
    data: { items: lists },
  } = useSuspenseQuery(legalListsOptions(workspaceId));

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

  if (lists.length === 0) {
    return (
      <div className="flex flex-col items-start gap-4 p-4">
        <EvidenceListEmptyState workspaceId={workspaceId} />
        <LoadSampleCaseButton view={view} workspaceId={workspaceId} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <EvidenceListPicker view={view} workspaceId={workspaceId} />
        {listId !== null && (
          <AvtModeSwitch mode={mode} onModeChange={onModeChange} />
        )}
      </div>
      {listId === null ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-muted-foreground text-sm">
            {t("avt.view.pickList")}
          </p>
          <LoadSampleCaseButton view={view} workspaceId={workspaceId} />
        </div>
      ) : (
        <ListReading
          listId={listId}
          mode={mode}
          onModeChange={onModeChange}
          onRunChange={onRunChange}
          workspaceId={workspaceId}
        />
      )}
    </div>
  );
};

type ListReadingProps = {
  workspaceId: string;
  listId: string;
  mode: AvtMode | undefined;
  onModeChange: (mode: AvtMode | undefined) => void;
  onRunChange: (runId: string | undefined) => void;
};

/** The chosen list read one of three ways: its review, graph or chronology. */
const ListReading = ({
  workspaceId,
  listId,
  mode,
  onModeChange,
  onRunChange,
}: ListReadingProps) => {
  const t = useTranslations();
  switch (mode) {
    case "graph": {
      return (
        <VerificationGraph
          listId={listId}
          onReview={() => onModeChange(undefined)}
          workspaceId={workspaceId}
        />
      );
    }
    case "chronology": {
      return <Chronology listId={listId} workspaceId={workspaceId} />;
    }
    case undefined: {
      return (
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
      );
    }
    default: {
      mode satisfies never;
      return panic(`Unhandled AVT mode: ${String(mode)}`);
    }
  }
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
  // The view's loader has already read the workspace's lists.
  const {
    data: { items },
  } = useSuspenseQuery(legalListsOptions(workspaceId));

  const pick = (listId: string) => {
    updateView.mutate(
      {
        viewId: view.id,
        layout: mergeLayout(view.layout, {
          listId: toSafeId<"legalList">(listId),
        }),
      },
      {
        onError: (error) => {
          notifyUserError(error, t("errors.actionFailed"));
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
        disabled={!canUpdateView}
        onValueChange={(next) => {
          if (next !== null && next !== view.layout.listId) {
            pick(next);
          }
        }}
        value={view.layout.listId}
      >
        <SelectTrigger
          aria-label={t("avt.view.evidenceList")}
          className="w-auto max-w-72"
          size="sm"
        >
          <SelectValue placeholder={t("avt.view.chooseList")} />
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

const REVIEW = "review";

/** Review, Graph or Chronology: three readings of the same list. */
const AvtModeSwitch = ({
  mode,
  onModeChange,
}: {
  mode: AvtMode | undefined;
  onModeChange: (mode: AvtMode | undefined) => void;
}) => {
  const t = useTranslations();
  return (
    <ToggleGroup
      aria-label={t("avt.mode.label")}
      onValueChange={(values) => {
        const next = values.at(0);
        // The pressed item cannot be clicked off: one reading is always on.
        if (next === undefined) {
          return;
        }
        onModeChange(next === REVIEW ? undefined : next);
      }}
      size="sm"
      value={[mode ?? REVIEW]}
    >
      <ToggleGroupItem value={REVIEW}>{t("avt.mode.review")}</ToggleGroupItem>
      <ToggleGroupItem value="graph">{t("avt.mode.graph")}</ToggleGroupItem>
      <ToggleGroupItem value="chronology">
        {t("avt.mode.chronology")}
      </ToggleGroupItem>
    </ToggleGroup>
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
