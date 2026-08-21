/**
 * The run half of the bilingual-translation dialog: follow one run while the
 * worker executes it, then report what it produced. The run is durable
 * server-side; this surface only reads it.
 */

import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DialogClose, DialogFooter, DialogPanel } from "@stll/ui/dialog";

import {
  bilingualErrorCodeKey,
  bilingualRunOptions,
  bilingualRunView,
  type BilingualRunDetail,
  type BilingualRunRow,
} from "@/components/bilingual-translate-queries";
import { userErrorFromThrown } from "@/lib/errors/user-safe";

type BilingualRunPanelProps = {
  workspaceId: string;
  runId: string;
  onOpenDocument: () => void;
  onRestart: () => void;
};

/** Flagged rows shown at once; the rest are reported as a count. */
const FLAGGED_ROW_LIMIT = 50;

export const BilingualRunPanel = ({
  workspaceId,
  runId,
  onOpenDocument,
  onRestart,
}: BilingualRunPanelProps) => {
  const t = useTranslations();
  const { data, error } = useQuery(bilingualRunOptions({ workspaceId, runId }));

  if (error !== null) {
    return (
      <>
        <DialogPanel>
          <p className="text-destructive text-sm">
            {userErrorFromThrown(error, t("errors.actionFailed"))}
          </p>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.close")}
          </DialogClose>
        </DialogFooter>
      </>
    );
  }

  if (data === undefined) {
    return (
      <DialogPanel>
        <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
      </DialogPanel>
    );
  }

  const view = bilingualRunView(data.run.status);
  if (view === "progress") {
    return <RunProgress detail={data} />;
  }
  if (view === "done") {
    return <RunDone detail={data} onOpenDocument={onOpenDocument} />;
  }
  return <RunStopped detail={data} onRestart={onRestart} />;
};

const RunProgress = ({ detail }: { detail: BilingualRunDetail }) => {
  const t = useTranslations();
  const { completed, total } = detail.run;
  const ratio = total === 0 ? 0 : Math.min(1, completed / total);

  return (
    <DialogPanel>
      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium">
          {t("bilingualTranslate.run.title")}
        </p>
        <div
          aria-label={t("bilingualTranslate.run.title")}
          aria-valuemax={total}
          aria-valuemin={0}
          aria-valuenow={completed}
          className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
          role="progressbar"
        >
          <div
            className="bg-primary h-full w-full origin-left rounded-full transition-transform duration-500 ease-out"
            style={{ transform: `scaleX(${String(ratio)})` }}
          />
        </div>
        <p className="text-muted-foreground text-xs tabular-nums">
          {t("bilingualTranslate.run.progress", {
            completed: String(completed),
            total: String(total),
          })}
        </p>
        <p className="text-muted-foreground text-xs">
          {t("bilingualTranslate.run.hint")}
        </p>
        <FlaggedRows rows={detail.rows} />
      </div>
    </DialogPanel>
  );
};

type RunDoneProps = {
  detail: BilingualRunDetail;
  onOpenDocument: () => void;
};

const RunDone = ({ detail, onOpenDocument }: RunDoneProps) => {
  const t = useTranslations();
  const translated = detail.rows.filter(
    (row) => row.status === "translated",
  ).length;
  const failed = detail.rows.filter((row) => row.status === "failed").length;

  return (
    <>
      <DialogPanel>
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium">
            {t("bilingualTranslate.run.doneTitle")}
          </p>
          <p className="text-muted-foreground text-sm">
            {t("bilingualTranslate.run.doneSummary", { count: translated })}
          </p>
          {failed > 0 && (
            <p className="text-destructive text-sm">
              {t("bilingualTranslate.run.failedRows", { count: failed })}
            </p>
          )}
          <FlaggedRows rows={detail.rows} />
        </div>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>
          {t("common.close")}
        </DialogClose>
        <Button onClick={onOpenDocument}>{t("common.open")}</Button>
      </DialogFooter>
    </>
  );
};

type RunStoppedProps = {
  detail: BilingualRunDetail;
  onRestart: () => void;
};

const RunStopped = ({ detail, onRestart }: RunStoppedProps) => {
  const t = useTranslations();
  const message =
    detail.run.status === "cancelled"
      ? t("bilingualTranslate.run.cancelled")
      : t(bilingualErrorCodeKey(detail.run.errorCode));

  return (
    <>
      <DialogPanel>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">
            {t("bilingualTranslate.run.failedTitle")}
          </p>
          <p className="text-muted-foreground text-sm">{message}</p>
        </div>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>
          {t("common.close")}
        </DialogClose>
        <Button onClick={onRestart}>{t("common.tryAgain")}</Button>
      </DialogFooter>
    </>
  );
};

/** Rows the reviewer should look at: a consistency warning, or a row the
 *  worker could not translate at all. */
const FlaggedRows = ({ rows }: { rows: BilingualRunRow[] }) => {
  const t = useTranslations();
  const flagged = rows.filter(
    (row) => row.warnings.length > 0 || row.status === "failed",
  );
  if (flagged.length === 0) {
    return null;
  }
  const shown = flagged.slice(0, FLAGGED_ROW_LIMIT);
  const hidden = flagged.length - shown.length;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">
        {t("bilingualTranslate.run.warningsTitle")}
      </p>
      <ul className="flex max-h-56 flex-col gap-2 overflow-y-auto rounded-md border p-2">
        {shown.map((row) => (
          <li className="flex gap-2 text-xs" key={row.rowId}>
            <AlertTriangleIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate" title={row.sourceText}>
                {row.sourceText}
              </span>
              {row.warnings.map((warning) => (
                <span className="text-muted-foreground" key={warning}>
                  {warning}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <p className="text-muted-foreground text-xs">
          {t("bilingualTranslate.run.moreRows", { count: hidden })}
        </p>
      )}
    </div>
  );
};
