import { useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@stll/ui/collapsible";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronRightIcon, Columns2Icon } from "@stll/ui/icons";
import { PopoverClose } from "@stll/ui/popover";
import { Skeleton } from "@stll/ui/skeleton";
import { SwitchField } from "@stll/ui/switch";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import type { ProvisionHistoryAnchor } from "@/features/statutes/components/provision-history";
import { StatuteStatusDot } from "@/features/statutes/components/statute-validity-indicator";
import {
  StatuteVersionList,
  StatuteVersionMenuPopover,
  useStatuteVersionLabel,
} from "@/features/statutes/components/statute-version-menu";
import type {
  ProvisionVersionRow,
  WordingRunStart,
} from "@/features/statutes/provision-version-runs.logic";
import {
  buildProvisionVersionRows,
  previousWordingVersion,
  runOpenTarget,
  runWindow,
} from "@/features/statutes/provision-version-runs.logic";
import type { ProvisionHistoryWalk } from "@/features/statutes/queries/provision-history";
import { provisionHistoryWalkOptions } from "@/features/statutes/queries/provision-history";
import type { PublicStatuteVersion } from "@/features/statutes/queries/statutes";
import { ineligibleExpressionLabelKey } from "@/features/statutes/statute-expression";
import {
  resolveStatuteDisplayStatus,
  STATUTE_STATUS_LABEL_KEYS,
} from "@/features/statutes/statute-status";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import {
  formatValidityDate,
  formatValidityRange,
} from "@/lib/statutes/statute-format";

const RUN_START_LABEL_KEYS = {
  changed: "statutes.provisionWordingChanged",
  added: "statutes.provisionWordingAdded",
  earliest: "statutes.provisionWordingEarliest",
  unknown: null,
} as const satisfies Record<WordingRunStart, TranslationKey | null>;

type ProvisionVersionMenuProps = {
  currentVersionId: string;
  /** The heading anchor the provision's history is filed under. */
  historyAnchor: ProvisionHistoryAnchor;
  /** Sets another version of the act beside the one on screen. */
  onCompare: (versionValidFrom: string) => void;
  /**
   * Opens the comparison of one wording against the one before it: `base`
   * carries the wording, `previous` is the version just before it changed.
   */
  onCompareWording: (
    base: PublicStatuteVersion,
    previous: PublicStatuteVersion,
  ) => void;
  onVersionChange: (documentId: string) => void;
  versions: readonly PublicStatuteVersion[];
};

/**
 * The act's versions as one provision lived through them: a row starts only
 * where the provision's wording changed, and the consolidations that kept it
 * fold into that row. The act's own list stays one switch away, because a
 * reader may still want the consolidation of a particular day.
 */
export const ProvisionVersionMenu = ({
  currentVersionId,
  historyAnchor,
  onCompare,
  onCompareWording,
  onVersionChange,
  versions,
}: ProvisionVersionMenuProps) => {
  const t = useTranslations();
  const versionLabel = useStatuteVersionLabel();
  const [open, setOpen] = useState(false);
  const [allVersions, setAllVersions] = useState(false);
  // Every consolidation costs the server one document read, so the history
  // is walked when the menu opens, not with the pane.
  const walk = useQuery({
    ...provisionHistoryWalkOptions({
      anchor: historyAnchor.type === "resolved" ? historyAnchor.anchor : "",
      documentId: currentVersionId,
    }),
    enabled: open && historyAnchor.type === "resolved",
  });

  if (versions.length < 2) {
    return null;
  }
  const currentVersion = versions.find(
    (version) => version.id === currentVersionId,
  );
  if (currentVersion === undefined) {
    return null;
  }

  const actList = (
    <StatuteVersionList
      currentVersionId={currentVersionId}
      onCompare={onCompare}
      onVersionChange={onVersionChange}
      versions={versions}
    />
  );

  return (
    <StatuteVersionMenuPopover
      onOpenChange={setOpen}
      triggerLabel={versionLabel(currentVersion)}
    >
      {historyAnchor.type === "unavailable" ? (
        actList
      ) : (
        <>
          <div className="border-b px-4">
            <SwitchField
              checked={allVersions}
              label={t("statutes.provisionVersionsAll")}
              onCheckedChange={setAllVersions}
              size="sm"
            />
          </div>
          <ProvisionVersionBody
            actList={actList}
            allVersions={allVersions}
            currentVersionId={currentVersionId}
            onCompareWording={onCompareWording}
            onVersionChange={onVersionChange}
            versions={versions}
            walk={walk}
          />
        </>
      )}
    </StatuteVersionMenuPopover>
  );
};

type ProvisionVersionBodyProps = Pick<
  ProvisionVersionMenuProps,
  "currentVersionId" | "onCompareWording" | "onVersionChange" | "versions"
> & {
  actList: ReactElement;
  allVersions: boolean;
  walk: { data: ProvisionHistoryWalk | undefined; isError: boolean };
};

const ProvisionVersionBody = ({
  actList,
  allVersions,
  currentVersionId,
  onCompareWording,
  onVersionChange,
  versions,
  walk,
}: ProvisionVersionBodyProps) => {
  const t = useTranslations();
  if (allVersions) {
    return actList;
  }
  if (walk.isError) {
    // The act's own list still opens every version; only the grouping is
    // missing.
    return (
      <>
        <p className="text-muted-foreground px-4 pt-2 text-xs" role="status">
          {t("statutes.provisionHistoryUnavailable")}
        </p>
        {actList}
      </>
    );
  }
  if (walk.data === undefined) {
    return (
      <div aria-busy="true" className="flex flex-col gap-1 px-4 py-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }
  const rows = buildProvisionVersionRows({ history: walk.data, versions });
  return (
    <ol className="relative py-1">
      <span
        aria-hidden="true"
        className="bg-border absolute inset-y-4 start-[1.15rem] w-px"
      />
      {rows.map((row) => (
        <ProvisionVersionRowItem
          currentVersionId={currentVersionId}
          key={rowKey(row)}
          onCompareWording={onCompareWording}
          onVersionChange={onVersionChange}
          row={row}
          versions={versions}
        />
      ))}
    </ol>
  );
};

const rowKey = (row: ProvisionVersionRow<PublicStatuteVersion>): string =>
  row.type === "unavailable" || row.type === "unread"
    ? row.version.id
    : (row.members.at(0)?.id ?? row.type);

const isFutureVersion = (version: PublicStatuteVersion): boolean =>
  resolveStatuteDisplayStatus({
    status: version.status,
    validFrom: version.versionValidFrom,
  }) === "future";

const inForceVersionId = (
  versions: readonly PublicStatuteVersion[],
): string | null =>
  versions.find(
    (version) =>
      version.isDefault && ineligibleExpressionLabelKey(version) === null,
  )?.id ?? null;

type RowItemProps = Pick<
  ProvisionVersionMenuProps,
  "currentVersionId" | "onCompareWording" | "onVersionChange" | "versions"
> & { row: ProvisionVersionRow<PublicStatuteVersion> };

/** One row of the grouped list, by what the row holds. */
const ProvisionVersionRowItem = ({
  currentVersionId,
  onCompareWording,
  onVersionChange,
  row,
  versions,
}: RowItemProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const versionLabel = useStatuteVersionLabel();
  const inForceId = inForceVersionId(versions);

  switch (row.type) {
    case "unavailable":
    case "unread":
      return (
        <VersionRow
          inForce={row.version.id === inForceId}
          members={[row.version]}
          note={
            row.type === "unavailable"
              ? t("statutes.provisionTextUnavailable")
              : null
          }
          onVersionChange={onVersionChange}
          selectedId={currentVersionId}
          target={row.version}
          title={versionLabel(row.version)}
        />
      );
    case "absent": {
      const newest = row.members.at(0);
      const oldest = row.members.at(-1);
      if (newest === undefined || oldest === undefined) {
        return null;
      }
      return (
        <VersionRow
          inForce={row.members.some((member) => member.id === inForceId)}
          members={row.members}
          note={t("statutes.provisionAbsentVersions", {
            count: row.members.length,
          })}
          onVersionChange={onVersionChange}
          selectedId={currentVersionId}
          target={
            runOpenTarget(row.members, {
              inForceId,
              isFuture: isFutureVersion,
              selectedId: currentVersionId,
            }) ?? newest
          }
          title={formatValidityRange({
            format,
            openEnded: t("statutes.openEnded"),
            validFrom: oldest.versionValidFrom,
            validTo: newest.versionValidTo,
          })}
        />
      );
    }
    case "run": {
      const target = runOpenTarget(row.members, {
        inForceId,
        isFuture: isFutureVersion,
        selectedId: currentVersionId,
      });
      if (target === undefined) {
        return null;
      }
      const window = runWindow(row.members, isFutureVersion);
      const previous = previousWordingVersion(row, versions);
      const startLabelKey =
        row.start === null ? null : RUN_START_LABEL_KEYS[row.start];
      // A wording that cannot apply offers no window to compare by, as in
      // the act's own list.
      const comparable =
        previous !== null &&
        previous.versionValidFrom !== null &&
        ineligibleExpressionLabelKey(previous) === null &&
        ineligibleExpressionLabelKey(target) === null;
      const alsoFrom =
        window.type === "window" && window.alsoFrom !== null
          ? formatValidityDate(window.alsoFrom, format)
          : null;
      const title =
        window.type === "future"
          ? t("lawHome.inForceFrom", {
              date: formatValidityDate(window.from, format) ?? "",
            })
          : formatValidityRange({
              format,
              openEnded: t("statutes.openEnded"),
              validFrom: window.from,
              validTo: window.to,
            });
      return (
        <VersionRow
          compare={
            comparable ? (
              <PopoverClose
                render={
                  <Button
                    aria-label={t("statutes.compareWithPreviousWording")}
                    onClick={() => onCompareWording(target, previous)}
                    size="icon-sm"
                    title={t("statutes.compareSideBySide")}
                    variant="ghost"
                  />
                }
              >
                <Columns2Icon className="size-3.5" />
              </PopoverClose>
            ) : null
          }
          inForce={row.members.some((member) => member.id === inForceId)}
          members={row.members}
          note={
            alsoFrom === null
              ? null
              : t("statutes.provisionRunAlsoFrom", { date: alsoFrom })
          }
          onVersionChange={onVersionChange}
          selectedId={currentVersionId}
          startLabel={startLabelKey === null ? null : t(startLabelKey)}
          summary={
            window.type === "window" && window.count > 1
              ? t("statutes.provisionRunUnchanged", { count: window.count })
              : null
          }
          target={target}
          title={title}
        />
      );
    }
    default: {
      row satisfies never;
      return panic("Unknown provision version row");
    }
  }
};

type VersionRowProps = {
  compare?: ReactNode;
  inForce: boolean;
  /** The act's versions the row stands for, newest first. */
  members: readonly PublicStatuteVersion[];
  note: string | null;
  onVersionChange: (documentId: string) => void;
  selectedId: string;
  startLabel?: string | null;
  summary?: string | null;
  /** The version the row opens. */
  target: PublicStatuteVersion;
  title: string;
};

/**
 * A row drawn as the act's own list draws one, so switching between the two
 * keeps every row in place: the status dot on the line, the window, and the
 * labels below it. A row standing for several versions lists them on
 * demand.
 */
const VersionRow = ({
  compare = null,
  inForce,
  members,
  note,
  onVersionChange,
  selectedId,
  startLabel = null,
  summary = null,
  target,
  title,
}: VersionRowProps) => {
  const t = useTranslations();
  const versionLabel = useStatuteVersionLabel();
  const [expanded, setExpanded] = useState(false);
  const selected = members.some((member) => member.id === selectedId);
  const expandable = members.length > 1;
  const trailing = (compare === null ? 0 : 1) + (expandable ? 1 : 0);
  const labels = [
    ...(inForce
      ? [{ key: "in-force", text: t(STATUTE_STATUS_LABEL_KEYS.current) }]
      : []),
    ...(startLabel === null ? [] : [{ key: "start", text: startLabel }]),
  ];

  const row = (
    <div className="relative">
      <Button
        aria-current={selected ? "true" : undefined}
        className="group/plain flex w-full"
        disabled={target.id === selectedId}
        disabledReason={t("statutes.versionAlreadySelected")}
        onClick={() => onVersionChange(target.id)}
        variant="plain"
      >
        <span
          className={cn(
            "group-hover/plain:bg-muted grid min-w-0 flex-1 grid-cols-[auto_1fr] items-start gap-3 rounded-md px-4 text-start",
            inForce ? "py-3" : "py-2",
            selected && "bg-muted/60",
            trailing === 1 && "pe-12",
            trailing === 2 && "pe-20",
          )}
        >
          <span className="bg-popover relative z-10 mt-1 flex size-2 items-center justify-center">
            <StatuteStatusDot
              expression={target}
              status={target.status}
              validFrom={target.versionValidFrom}
            />
          </span>
          <span className="min-w-0">
            <span
              className={cn(
                "block text-sm tabular-nums",
                inForce && "font-semibold",
                !inForce && !selected && "text-muted-foreground",
              )}
            >
              {title}
              {summary === null ? null : (
                <span className="text-muted-foreground font-normal">
                  {" · "}
                  {summary}
                </span>
              )}
            </span>
            {labels.length === 0 ? null : (
              <span className="text-2xs mt-0.5 block font-medium tracking-wide uppercase">
                {labels.map((label, index) => (
                  <span
                    className={cn(
                      label.key === "in-force"
                        ? "text-success"
                        : "text-muted-foreground",
                    )}
                    key={label.key}
                  >
                    {index === 0 ? null : " · "}
                    {label.text}
                  </span>
                ))}
              </span>
            )}
            {note === null ? null : (
              <span className="text-muted-foreground mt-0.5 block text-xs tabular-nums">
                {note}
              </span>
            )}
          </span>
        </span>
      </Button>
      {trailing === 0 ? null : (
        <span className="absolute end-2 top-1/2 flex -translate-y-1/2 items-center">
          {expandable ? (
            <CollapsibleTrigger
              render={
                <Button
                  aria-label={t("statutes.provisionRunShowVersions", {
                    range: title,
                  })}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <DirectionalIcon
                className={cn(
                  "size-3.5 transition-transform",
                  expanded && "rotate-90",
                )}
                flip={!expanded}
                icon={ChevronRightIcon}
              />
            </CollapsibleTrigger>
          ) : null}
          {compare}
        </span>
      )}
    </div>
  );

  if (!expandable) {
    return <li className="relative">{row}</li>;
  }
  return (
    <li className="relative">
      <Collapsible onOpenChange={setExpanded} open={expanded}>
        {row}
        <CollapsiblePanel hiddenUntilFound={false}>
          <ol className="pb-1">
            {members.map((member) => (
              <li key={member.id}>
                <Button
                  aria-current={member.id === selectedId ? "true" : undefined}
                  className="group/plain flex w-full"
                  disabled={member.id === selectedId}
                  disabledReason={t("statutes.versionAlreadySelected")}
                  onClick={() => onVersionChange(member.id)}
                  variant="plain"
                >
                  <span
                    className={cn(
                      "group-hover/plain:bg-muted grid min-w-0 flex-1 grid-cols-[auto_1fr] items-center gap-3 rounded-md py-1.5 ps-9 pe-4 text-start text-xs tabular-nums",
                      member.id === selectedId
                        ? "bg-muted/60 font-medium"
                        : "text-muted-foreground",
                    )}
                  >
                    <StatuteStatusDot
                      expression={member}
                      status={member.status}
                      validFrom={member.versionValidFrom}
                    />
                    <TruncatedText>{versionLabel(member)}</TruncatedText>
                  </span>
                </Button>
              </li>
            ))}
          </ol>
        </CollapsiblePanel>
      </Collapsible>
    </li>
  );
};
