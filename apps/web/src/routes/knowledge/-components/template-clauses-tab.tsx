import { useCallback, useState } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/alert-dialog";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  AiActionIcon,
  XIcon,
} from "@stll/ui/icons";
import { stellaToast } from "@stll/ui/toast";

import {
  VersionDiffBlock,
  VersionSummaryBlock,
} from "@/components/versions/version-list";
import type {
  AsyncContent,
  VersionDiffSegment,
} from "@/components/versions/version-list";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { toAPIError, unwrapEden } from "@/lib/errors/api";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";

// ── Types ────────────────────────────────────────────

export type LinkedClause = {
  id: string;
  clauseId: string | null;
  clauseVariantId: string | null;
  clauseVariantLabel: string | null;
  clauseVersionId: string | null;
  slotName: string | null;
  sortOrder: number;
  insertedAt: string;
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

export const OutdatedChanges = ({
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
    const requested = await Result.tryPromise(async () =>
      unwrapEden(
        await api
          .clauses({ clauseId: toSafeId<"clause">(clauseId) })
          .versions({ versionId: toSafeId<"clauseVersion">(versionId) })
          .diff.get(),
      ),
    );
    if (Result.isError(requested)) {
      setDiff({ status: "error" });
      return;
    }
    setDiff({ status: "ready", value: requested.value.segments });
  };

  const handleSummarize = async () => {
    if (summary.status === "loading") {
      return;
    }
    setSummary({ status: "loading" });
    const requested = await Result.tryPromise(async () =>
      unwrapEden(
        await api
          .clauses({ clauseId: toSafeId<"clause">(clauseId) })
          .versions({ versionId: toSafeId<"clauseVersion">(versionId) })
          .summarize.post(),
      ),
    );
    if (Result.isError(requested)) {
      setSummary({ status: "error" });
      return;
    }
    setSummary({ status: "ready", value: requested.value.summary });
  };

  return (
    <div className="mt-1">
      <div className="flex items-center gap-0.5">
        <Button
          aria-expanded={isDiffOpen}
          className="gap-1"
          onClick={() => {
            detached(toggleDiff(), "template-clauses-tab.toggle-diff");
          }}
          size="xs"
          variant="muted"
        >
          {isDiffOpen ? (
            <ChevronDownIcon className="size-3" />
          ) : (
            <DirectionalIcon className="size-3" icon={ChevronRightIcon} />
          )}
          {t("fileDetail.showDiff")}
        </Button>
        <Button
          aria-label={t("common.summarizeChanges")}
          disabled={summary.status === "loading"}
          onClick={() => {
            detached(handleSummarize(), "template-clauses-tab.summarize");
          }}
          size="icon-xs"
          title={t("common.summarizeChanges")}
          variant="muted"
        >
          {summary.status === "loading" ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <AiActionIcon className="size-3.5" />
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

type UnlinkButtonProps = {
  linkId: string;
  templateId: string;
  onChanged: () => void;
  destructive?: boolean;
};

export const UnlinkButton = ({
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
      notifyUserError(toAPIError(response.error), t("clauses.unlinkFailed"), {
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
        className="shrink-0"
        onClick={() => setUnlinkOpen(true)}
        size="sm"
        variant={destructive ? "destructive-ghost" : "ghost"}
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
              detached(handleUnlink(), "template-clauses-tab.unlink");
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
