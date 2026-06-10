import { useCallback, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  WandSparklesIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/components/alert-dialog";
import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import {
  VersionDiffBlock,
  VersionSummaryBlock,
} from "@/components/versions/version-list";
import type {
  AsyncContent,
  VersionDiffSegment,
} from "@/components/versions/version-list";
import { api } from "@/lib/api";
import { toAPIError, userErrorMessage } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { LinkClauseDialog } from "@/routes/_protected.knowledge/-components/link-clause-dialog";
import {
  knowledgeKeys,
  templateClausesOptions,
} from "@/routes/_protected.knowledge/-queries";

// ── Types ────────────────────────────────────────────

type LinkedClause = {
  id: string;
  clauseId: string | null;
  clauseVariantId: string | null;
  clauseVariantLabel: string | null;
  clauseVersionId: string | null;
  slotName: string | null;
  sortOrder: number;
  insertedAt: Date;
  clause: {
    id: string;
    title: string;
    currentVersion: number;
  } | null;
  clauseVersion: {
    id: string;
    version: number;
  } | null;
  clauseVariant: {
    id: string;
    label: string;
  } | null;
  isOutdated: boolean;
  variantDeleted: boolean;
};

type TemplateClausesTabProps = {
  templateId: string;
};

// ── Component ────────────────────────────────────────

const protectedRouteApi = getRouteApi("/_protected");

export const TemplateClausesTab = ({ templateId }: TemplateClausesTabProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const [linkOpen, setLinkOpen] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);

  const { data, isLoading, isError } = useQuery(
    templateClausesOptions(activeOrganizationId, templateId),
  );

  const links: LinkedClause[] =
    data && "links" in data && Array.isArray(data.links) ? data.links : [];
  const outdatedCount = links.filter((link) => link.isOutdated).length;

  const invalidateLinks = useCallback(() => {
    queryClient
      .invalidateQueries({
        queryKey: knowledgeKeys.templates.clauses(
          activeOrganizationId,
          templateId,
        ),
      })
      .catch(() => {
        /* fire-and-forget */
      });
  }, [activeOrganizationId, queryClient, templateId]);

  const handleSyncAll = useCallback(async () => {
    setSyncingAll(true);

    const response = await api
      .templates({ templateId: toSafeId<"template">(templateId) })
      .clauses.sync.post();

    setSyncingAll(false);

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("clauses.syncFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    if ("syncedCount" in response.data) {
      stellaToast.add({
        type: "success",
        title: t("clauses.syncedAllResult", {
          count: response.data.syncedCount,
        }),
      });
    }
    invalidateLinks();
  }, [templateId, t, invalidateLinks]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("templates.discovering")}
        </p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("clauses.loadFailed")}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-muted-foreground text-sm font-medium">
          {t("clauses.linkedClauses")}
        </h3>
        <div className="flex items-center gap-1.5">
          {outdatedCount > 0 && (
            <Button
              disabled={syncingAll}
              onClick={() => {
                void handleSyncAll();
              }}
              size="sm"
              variant="outline"
            >
              <RefreshCwIcon className={cn(syncingAll && "animate-spin")} />
              {t("clauses.syncAllOutdated")}
            </Button>
          )}
          <Button onClick={() => setLinkOpen(true)} size="sm" variant="outline">
            <PlusIcon />
            {t("clauses.linkClause")}
          </Button>
        </div>
      </div>

      {links.length === 0 && (
        <p className="text-muted-foreground py-4 text-center text-sm">
          {t("clauses.noLinkedClauses")}
        </p>
      )}

      {links.length > 0 && (
        <div className="rounded-lg border">
          <ul className="divide-y">
            {links.map((link) => (
              <LinkedClauseRow
                key={link.id}
                link={link}
                onChanged={invalidateLinks}
                templateId={templateId}
              />
            ))}
          </ul>
        </div>
      )}

      <LinkClauseDialog
        onLinked={invalidateLinks}
        onOpenChange={setLinkOpen}
        open={linkOpen}
        templateId={templateId}
      />
    </div>
  );
};

// ── Linked Clause Row ────────────────────────────────

type LinkedClauseRowProps = {
  link: LinkedClause;
  templateId: string;
  onChanged: () => void;
};

const LinkedClauseRow = ({
  link,
  templateId,
  onChanged,
}: LinkedClauseRowProps) => {
  const t = useTranslations();
  const [syncing, setSyncing] = useState(false);

  const isDeleted = link.clause === null;

  const handleSync = useCallback(async () => {
    setSyncing(true);

    const response = await api
      .templates({ templateId: toSafeId<"template">(templateId) })
      .clauses({ linkId: toSafeId<"templateClause">(link.id) })
      .sync.post();

    setSyncing(false);

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("clauses.syncFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    stellaToast.add({
      type: "success",
      title: t("clauses.synced"),
    });
    onChanged();
  }, [link.id, templateId, t, onChanged]);

  if (isDeleted) {
    return (
      <li className="bg-destructive/5 flex items-center gap-3 px-4 py-3">
        <Trash2Icon className="text-destructive size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-destructive text-sm font-medium">
            {t("clauses.clauseDeletedTombstone")}
          </p>
          <div className="flex items-center gap-2 text-xs">
            {link.slotName && <SlotChip slotName={link.slotName} />}
            <span className="text-destructive/80">
              {t("clauses.clauseDeletedHint")}
            </span>
          </div>
        </div>
        <UnlinkButton
          destructive
          linkId={link.id}
          onChanged={onChanged}
          templateId={templateId}
        />
      </li>
    );
  }

  return (
    <li className="flex flex-col px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{link.clause?.title}</p>
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
            {link.slotName && <SlotChip slotName={link.slotName} />}
            {link.clauseVariant && <span>{link.clauseVariant.label}</span>}
            {link.variantDeleted && (
              <span className="text-warning-foreground flex items-center gap-1">
                <AlertTriangleIcon className="size-3" />
                {t("clauses.variantDeletedWithLabel", {
                  label: link.clauseVariantLabel ?? "",
                })}
              </span>
            )}
            {link.clauseVersion && (
              <span>
                {t("clauses.version", {
                  version: String(link.clauseVersion.version),
                })}
              </span>
            )}
            {link.isOutdated && (
              <span className="text-warning-foreground flex items-center gap-1">
                <AlertTriangleIcon className="size-3" />
                {t("clauses.outdatedVersion")}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 gap-1">
          {link.isOutdated && (
            <Button
              disabled={syncing}
              onClick={() => {
                void handleSync();
              }}
              size="sm"
              variant="ghost"
            >
              <RefreshCwIcon className="size-3.5" />
              {t("clauses.syncVersion")}
            </Button>
          )}

          <UnlinkButton
            linkId={link.id}
            onChanged={onChanged}
            templateId={templateId}
          />
        </div>
      </div>

      {link.variantDeleted && link.slotName && (
        <p className="text-warning-foreground mt-1 text-xs">
          {t("clauses.variantDeletedNoFill", { slot: link.slotName })}
        </p>
      )}

      {link.isOutdated && link.clauseId && link.clauseVersion && (
        <OutdatedChanges
          clauseId={link.clauseId}
          versionId={link.clauseVersion.id}
        />
      )}
    </li>
  );
};

// ── Outdated changes disclosure ──────────────────────

// Expands the "update available" state into a line diff between the
// pinned version and the clause's current one, plus an on-demand AI
// summary; rendering reuses the shared version-history blocks.
const OutdatedChanges = ({
  clauseId,
  versionId,
}: {
  clauseId: string;
  versionId: string;
}) => {
  const t = useTranslations();
  const [isDiffOpen, setIsDiffOpen] = useState(false);
  const [diff, setDiff] = useState<AsyncContent<VersionDiffSegment[]>>({
    status: "idle",
  });
  const [summary, setSummary] = useState<AsyncContent<string | null>>({
    status: "idle",
  });

  const toggleDiff = async () => {
    const nextOpen = !isDiffOpen;
    setIsDiffOpen(nextOpen);
    if (!nextOpen || diff.status === "ready" || diff.status === "loading") {
      return;
    }
    setDiff({ status: "loading" });
    try {
      const response = await api
        .clauses({ clauseId: toSafeId<"clause">(clauseId) })
        .versions({ versionId: toSafeId<"clauseVersion">(versionId) })
        .diff.get();
      if (response.error) {
        throw toAPIError(response.error);
      }
      setDiff({ status: "ready", value: response.data.segments });
    } catch {
      setDiff({ status: "error" });
    }
  };

  const handleSummarize = async () => {
    if (summary.status === "loading") {
      return;
    }
    setSummary({ status: "loading" });
    try {
      const response = await api
        .clauses({ clauseId: toSafeId<"clause">(clauseId) })
        .versions({ versionId: toSafeId<"clauseVersion">(versionId) })
        .summarize.post();
      if (response.error) {
        throw toAPIError(response.error);
      }
      setSummary({ status: "ready", value: response.data.summary });
    } catch {
      setSummary({ status: "error" });
    }
  };

  return (
    <div className="mt-1">
      <div className="flex items-center gap-0.5">
        <Button
          aria-expanded={isDiffOpen}
          className="text-muted-foreground hover:text-foreground gap-1 px-1.5 text-xs font-normal"
          onClick={() => {
            void toggleDiff();
          }}
          size="xs"
          variant="ghost"
        >
          {isDiffOpen ? (
            <ChevronDownIcon className="size-3" />
          ) : (
            <ChevronRightIcon className="size-3" />
          )}
          {t("fileDetail.showDiff")}
        </Button>
        <Button
          aria-label={t("common.summarizeChanges")}
          className="text-muted-foreground hover:text-foreground"
          disabled={summary.status === "loading"}
          onClick={() => {
            void handleSummarize();
          }}
          size="icon-xs"
          title={t("common.summarizeChanges")}
          variant="ghost"
        >
          {summary.status === "loading" ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <WandSparklesIcon className="size-3.5" />
          )}
        </Button>
      </div>

      {isDiffOpen && (
        <div className="mt-1">
          <VersionDiffBlock state={diff} />
        </div>
      )}

      <VersionSummaryBlock state={summary} />
    </div>
  );
};

// ── Shared bits ──────────────────────────────────────

const SlotChip = ({ slotName }: { slotName: string }) => (
  <span className="bg-muted text-foreground rounded-sm px-1.5 py-0.5">
    {slotName}
  </span>
);

// One unlink flow (trigger button + confirm dialog) shared by the
// tombstone row and the regular row; the tombstone renders it in a
// destructive tint.
type UnlinkButtonProps = {
  linkId: string;
  templateId: string;
  onChanged: () => void;
  destructive?: boolean;
};

const UnlinkButton = ({
  linkId,
  templateId,
  onChanged,
  destructive = false,
}: UnlinkButtonProps) => {
  const t = useTranslations();
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  const handleUnlink = useCallback(async () => {
    setUnlinking(true);

    const response = await api
      .templates({ templateId: toSafeId<"template">(templateId) })
      .clauses({ linkId: toSafeId<"templateClause">(linkId) })
      .delete();

    setUnlinking(false);

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("clauses.unlinkFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    stellaToast.add({
      type: "success",
      title: t("clauses.unlinked"),
    });
    setUnlinkOpen(false);
    onChanged();
  }, [linkId, templateId, t, onChanged]);

  return (
    <AlertDialog onOpenChange={setUnlinkOpen} open={unlinkOpen}>
      <Button
        className={cn(
          "shrink-0",
          destructive && "text-destructive hover:text-destructive",
        )}
        onClick={() => setUnlinkOpen(true)}
        size="sm"
        variant="ghost"
      >
        <XIcon className="size-3.5" />
        {t("clauses.unlinkClause")}
      </Button>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("clauses.unlinkClause")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("clauses.unlinkConfirm")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </AlertDialogClose>
          <Button
            disabled={unlinking}
            onClick={() => {
              void handleUnlink();
            }}
            variant="destructive"
          >
            {t("clauses.unlinkClause")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
};
