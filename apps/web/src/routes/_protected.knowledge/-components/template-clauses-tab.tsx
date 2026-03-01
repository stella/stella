import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangleIcon,
  PlusIcon,
  RefreshCwIcon,
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
} from "@stella/ui/components/alert-dialog";
import { Button } from "@stella/ui/components/button";
import { toastManager } from "@stella/ui/components/toast";

import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import { LinkClauseDialog } from "@/routes/_protected.knowledge/-components/link-clause-dialog";

// ── Types ────────────────────────────────────────────

type LinkedClause = {
  id: string;
  clauseId: string | null;
  clauseVariantId: string | null;
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
};

type TemplateClausesTabProps = {
  templateId: string;
  /** Clause slot names discovered in the template. */
  clauseSlots?: string[];
};

// ── Component ────────────────────────────────────────

export const TemplateClausesTab = ({
  templateId,
  clauseSlots,
}: TemplateClausesTabProps) => {
  const t = useTranslations();
  const [links, setLinks] = useState<LinkedClause[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);

  const fetchLinks = useCallback(async () => {
    const response = await api.templates({ templateId }).clauses.get();

    if (response.error) {
      toastManager.add({
        type: "error",
        title: t("clauses.loadFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      setLoaded(true);
      return;
    }

    const { data } = response;
    if (data instanceof Response) {
      setLoaded(true);
      return;
    }

    if ("links" in data && Array.isArray(data.links)) {
      setLinks(data.links);
    }
    setLoaded(true);
  }, [templateId, t]);

  useEffect(() => {
    // biome-ignore lint/nursery/noFloatingPromises: fire-and-forget in effect
    fetchLinks();
  }, [fetchLinks]);

  if (!loaded) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-sm text-muted-foreground">
          {t("templates.discovering")}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">
          {t("clauses.linkedClauses")}
        </h3>
        <Button onClick={() => setLinkOpen(true)} size="sm" variant="outline">
          <PlusIcon />
          {t("clauses.linkClause")}
        </Button>
      </div>

      {links.length === 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">
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
                onChanged={fetchLinks}
                templateId={templateId}
              />
            ))}
          </ul>
        </div>
      )}

      <LinkClauseDialog
        availableSlots={clauseSlots}
        onLinked={fetchLinks}
        onOpenChange={setLinkOpen}
        open={linkOpen}
        templateId={templateId}
      />
    </div>
  );
};

// ── Linked Clause Row ────────────────────────────────

const LinkedClauseRow = ({
  link,
  templateId,
  onChanged,
}: {
  link: LinkedClause;
  templateId: string;
  onChanged: () => void;
}) => {
  const t = useTranslations();
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const isDeleted = link.clause === null;

  const handleUnlink = useCallback(async () => {
    setUnlinking(true);

    const response = await api
      .templates({ templateId })
      .clauses({ linkId: link.id })
      .delete();

    setUnlinking(false);

    if (response.error) {
      toastManager.add({
        type: "error",
        title: t("clauses.unlinkFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    toastManager.add({
      type: "success",
      title: t("clauses.unlinked"),
    });
    setUnlinkOpen(false);
    onChanged();
  }, [link.id, templateId, t, onChanged]);

  const handleSync = useCallback(async () => {
    setSyncing(true);

    const response = await api
      .templates({ templateId })
      .clauses({ linkId: link.id })
      .sync.post();

    setSyncing(false);

    if (response.error) {
      toastManager.add({
        type: "error",
        title: t("clauses.syncFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    toastManager.add({
      type: "success",
      title: t("clauses.synced"),
    });
    onChanged();
  }, [link.id, templateId, t, onChanged]);

  return (
    <li
      className={`flex items-center gap-3 px-4 py-3 ${
        isDeleted ? "bg-muted/30" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        {isDeleted ? (
          <p className="text-sm text-muted-foreground line-through">
            {t("clauses.clauseDeletedTombstone")}
          </p>
        ) : (
          <>
            <p className="text-sm font-medium">{link.clause?.title}</p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {link.slotName && (
                <span className="rounded-sm bg-purple-100 px-1.5 py-0.5 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
                  {link.slotName}
                </span>
              )}
              {link.clauseVariant && <span>{link.clauseVariant.label}</span>}
              {link.clauseVersion && (
                <span>
                  {t("clauses.version", {
                    version: String(link.clauseVersion.version),
                  })}
                </span>
              )}
              {link.isOutdated && (
                <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <AlertTriangleIcon className="size-3" />
                  {t("clauses.outdatedVersion")}
                </span>
              )}
            </div>
          </>
        )}
      </div>

      <div className="flex shrink-0 gap-1">
        {link.isOutdated && !isDeleted && (
          <Button
            disabled={syncing}
            onClick={handleSync}
            size="sm"
            variant="ghost"
          >
            <RefreshCwIcon className="size-3.5" />
            {t("clauses.syncVersion")}
          </Button>
        )}

        <AlertDialog onOpenChange={setUnlinkOpen} open={unlinkOpen}>
          <Button onClick={() => setUnlinkOpen(true)} size="sm" variant="ghost">
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
                onClick={handleUnlink}
                variant="destructive"
              >
                {t("clauses.unlinkClause")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </div>
    </li>
  );
};
