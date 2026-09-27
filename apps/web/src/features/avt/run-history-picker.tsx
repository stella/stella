/**
 * Switch between the verifications of one document: every run, newest first,
 * with when it ran, how it ended and what it found.
 */

import { useInfiniteQuery } from "@tanstack/react-query";
import { HistoryIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { Loader } from "@stll/ui/loader";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@stll/ui/menu";
import { ReviewStatusBadge } from "@stll/ui/review-status-badge";

import { verificationHistoryOptions } from "@/features/avt/queries";
import { runHistoryOptions } from "@/features/avt/run-history.logic";
import type { RunHistoryOption } from "@/features/avt/run-history.logic";
import type { VerificationRun } from "@/features/avt/types";
import { RUN_STATUS_LABEL_KEYS, RUN_STATUS_TONES } from "@/features/avt/types";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";

type RunHistoryPickerProps = {
  workspaceId: string;
  /** The run on screen. */
  run: VerificationRun;
  /** The view's list; a run checked against another one is marked. */
  listId: string | null;
  onOpenRun: (runId: string) => void;
};

export const RunHistoryPicker = ({
  workspaceId,
  run,
  listId,
  onOpenRun,
}: RunHistoryPickerProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const history = useInfiniteQuery(
    verificationHistoryOptions({
      workspaceId,
      entityId: run.entityId,
      fileFieldId: run.fileFieldId,
    }),
  );
  const options = runHistoryOptions(
    history.data?.pages.flatMap((page) => page.items) ?? [],
    listId,
  );
  const formatDate = (epochMs: number) =>
    format.dateTime(epochMs, MEDIUM_DATE_SHORT_TIME_FORMAT);

  return (
    <Menu>
      <MenuTrigger
        aria-label={t("avt.runs.history.label")}
        render={<Button className="ms-auto" size="sm" variant="outline" />}
      >
        <HistoryIcon />
        <span className="tabular-nums">
          {formatDate(Temporal.Instant.from(run.createdAt).epochMilliseconds)}
        </span>
      </MenuTrigger>
      <MenuPopup align="end" className="w-80">
        {history.isPending && (
          <div className="text-muted-foreground flex items-center gap-2 p-2 text-sm">
            <Loader label={t("common.loading")} size="sm" />
            {t("common.loading")}
          </div>
        )}
        {history.isError && options.length === 0 && (
          <p className="text-muted-foreground p-2 text-sm">
            {t("avt.runs.history.loadFailed")}
          </p>
        )}
        {options.length > 0 && (
          <MenuRadioGroup value={run.id}>
            {options.map((option) => (
              <MenuRadioItem
                closeOnClick
                key={option.id}
                label={formatDate(option.createdAtMs)}
                onClick={() => {
                  if (option.id !== run.id) {
                    onOpenRun(option.id);
                  }
                }}
                value={option.id}
              >
                <RunOptionLabel
                  date={formatDate(option.createdAtMs)}
                  option={option}
                />
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        )}
        {history.hasNextPage && (
          <MenuItem
            closeOnClick={false}
            disabled={history.isFetchingNextPage}
            onClick={() => {
              detached(history.fetchNextPage(), "avt.run-history.load-more");
            }}
          >
            {history.isFetchingNextPage && (
              <Loader label={t("common.loading")} size="sm" />
            )}
            {t("common.loadMore")}
          </MenuItem>
        )}
      </MenuPopup>
    </Menu>
  );
};

const RunOptionLabel = ({
  option,
  date,
}: {
  option: RunHistoryOption;
  date: string;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const { claimCounts } = option;

  return (
    <span className="flex flex-col gap-0.5 py-0.5">
      <span className="flex items-center gap-2">
        <span className="tabular-nums">{date}</span>
        <ReviewStatusBadge tone={RUN_STATUS_TONES[option.status]}>
          {t(RUN_STATUS_LABEL_KEYS[option.status])}
        </ReviewStatusBadge>
      </span>
      {(claimCounts !== null || option.otherList) && (
        <span className="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
          {claimCounts !== null && (
            <span className="tabular-nums">
              {t("avt.documents.claimSummary", {
                contradicted: format.number(claimCounts.contradicted),
                tension: format.number(claimCounts.tension),
                conflicts: format.number(claimCounts.recordconflict),
              })}
            </span>
          )}
          {option.otherList && <span>{t("avt.documents.otherList")}</span>}
        </span>
      )}
    </span>
  );
};
