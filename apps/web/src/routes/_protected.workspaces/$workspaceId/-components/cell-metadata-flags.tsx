import { useEffect, useMemo, useRef } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  CheckIcon,
  CheckCircle2Icon,
  HelpCircleIcon,
  LockIcon,
  LockOpenIcon,
  MessageSquareWarningIcon,
  ShieldAlertIcon,
  StarIcon,
  XIcon,
} from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useLocale, useTranslations } from "use-intl";

import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
} from "@stll/ui/components/menu";
import { stellaToast } from "@stll/ui/components/toast";

import Tooltip from "@/components/tooltip";
import { UserAvatar } from "@/components/user-avatar";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { formatRelativeTime } from "@/lib/relative-time";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceCellMetadata } from "@/lib/types";
import {
  cellOverrideKey,
  useCellMetadataOverridesStore,
} from "@/routes/_protected.workspaces/$workspaceId/-components/cell-metadata-overrides-store";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

const CELL_FLAG_IDS = [
  "needs-review",
  "important",
  "follow-up",
  "contradiction",
  "verified",
] as const;

type CellFlagId = (typeof CELL_FLAG_IDS)[number];

const VERIFIED_FLAG_ID = "verified";

type CellFlagDefinition = {
  id: CellFlagId;
  icon: LucideIcon;
  color: string;
  background: string;
};

const VERIFIED_CELL_FLAG = {
  id: VERIFIED_FLAG_ID,
  icon: CheckCircle2Icon,
  color: "var(--option-emerald)",
  background: "var(--option-emerald-bg)",
} as const satisfies CellFlagDefinition;

const CELL_FLAGS = [
  {
    id: "needs-review",
    icon: HelpCircleIcon,
    color: "var(--option-amber)",
    background: "var(--option-amber-bg)",
  },
  {
    id: "important",
    icon: StarIcon,
    color: "var(--option-blue)",
    background: "var(--option-blue-bg)",
  },
  {
    id: "follow-up",
    icon: MessageSquareWarningIcon,
    color: "var(--option-violet)",
    background: "var(--option-violet-bg)",
  },
  {
    id: "contradiction",
    icon: ShieldAlertIcon,
    color: "var(--option-red)",
    background: "var(--option-red-bg)",
  },
  VERIFIED_CELL_FLAG,
] as const satisfies readonly CellFlagDefinition[];

const cellFlagsById = new Map<string, CellFlagDefinition>(
  CELL_FLAGS.map((flag) => [flag.id, flag]),
);

const FLAG_LABEL_KEYS = {
  "needs-review": "workspaces.table.flags.needsReview",
  important: "workspaces.table.flags.important",
  "follow-up": "workspaces.table.flags.followUp",
  contradiction: "workspaces.table.flags.contradiction",
  verified: "workspaces.table.flags.verified",
} as const;

type FlagProvenance = NonNullable<
  WorkspaceCellMetadata["flagProvenance"]
>[string];

type LockProvenance = NonNullable<WorkspaceCellMetadata["lockProvenance"]>;

const useFlagLabel = () => {
  const t = useTranslations();
  return (flagId: CellFlagId) => t(FLAG_LABEL_KEYS[flagId]);
};

const normalizeManualFlags = (flags: string[]) =>
  [...new Set(flags)].toSorted();

const haveSameFlags = (a: string[], b: string[]) =>
  a.length === b.length && a.every((flag, index) => flag === b[index]);

type UpdateCellMetadataVariables = {
  baseManualFlags: string[];
  manualFlags: string[];
  locked?: boolean;
};

type CellMetadataFlagsProps = {
  workspaceId: string;
  entityId: string;
  propertyId: string;
  metadata: WorkspaceCellMetadata | undefined;
};

export const CellMetadataFlags = ({
  workspaceId,
  entityId,
  propertyId,
  metadata,
}: CellMetadataFlagsProps) => {
  const t = useTranslations();
  const getFlagLabel = useFlagLabel();
  const {
    activeFlags,
    hasVerifiedFlag,
    isLocked,
    lockProvenance,
    setLocked,
    toggleFlag,
  } = useCellMetadataFlags({
    entityId,
    metadata,
    propertyId,
    workspaceId,
  });
  const hasActiveFlag = activeFlags.length > 0;
  const verifiedProvenance = metadata?.flagProvenance?.[VERIFIED_FLAG_ID];

  return (
    <>
      {hasVerifiedFlag && (
        <span
          aria-hidden
          // Negative z-index keeps the tint behind cell text. The
          // parent WorkspaceGridCell sets `relative z-0`, which
          // creates a stacking context so this stays scoped to the
          // cell.
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundColor: VERIFIED_CELL_FLAG.background,
            opacity: 0.28,
            zIndex: -1,
          }}
        />
      )}
      {isLocked ? (
        <CellLockBadge
          onUnlock={() => setLocked(false)}
          provenance={lockProvenance}
        />
      ) : (
        <Tooltip
          content={t("workspaces.table.lock.lock")}
          render={
            <button
              aria-label={t("workspaces.table.lock.lock")}
              className="bg-background/55 text-foreground-ghost focus-visible:ring-ring absolute start-1 top-1 z-20 flex size-3 items-center justify-center rounded-full opacity-0 backdrop-blur-[2px] transition-opacity outline-none group-hover/cell-content:opacity-100 focus-visible:ring-1"
              data-row-expansion-ignore
              onClick={(event) => {
                event.stopPropagation();
                setLocked(true);
              }}
              type="button"
            />
          }
        >
          <LockIcon className="size-2.5" strokeWidth={2.5} />
        </Tooltip>
      )}
      {hasActiveFlag ? (
        <CellCornerFlag
          flags={activeFlags}
          metadata={metadata}
          onDrop={toggleFlag}
        />
      ) : (
        <Tooltip
          className="max-w-72 text-wrap"
          content={
            <FlagProvenanceTooltip
              flag={VERIFIED_CELL_FLAG}
              metadata={verifiedProvenance}
            />
          }
          render={
            <button
              aria-label={getFlagLabel(VERIFIED_FLAG_ID)}
              className="bg-background/55 text-foreground-ghost focus-visible:ring-ring absolute end-1 top-1 z-20 flex size-3 items-center justify-center rounded-full opacity-0 backdrop-blur-[2px] transition-opacity outline-none group-hover/cell-content:opacity-100 focus-visible:ring-1"
              onClick={(event) => {
                event.stopPropagation();
                toggleFlag(VERIFIED_FLAG_ID);
              }}
              type="button"
            />
          }
        >
          <CheckCircle2Icon className="size-2.5" strokeWidth={2.5} />
        </Tooltip>
      )}
    </>
  );
};

type CellCornerFlagProps = {
  flags: CellFlagDefinition[];
  metadata: WorkspaceCellMetadata | undefined;
  onDrop: (flag: CellFlagId) => void;
};

const CellCornerFlag = ({ flags, metadata, onDrop }: CellCornerFlagProps) => {
  const getFlagLabel = useFlagLabel();
  if (flags.length === 0) {
    return null;
  }

  return (
    <div
      className="absolute end-1 top-1 z-20 flex items-center gap-1"
      data-row-expansion-ignore
    >
      {flags.map((flag) => {
        const Icon = flag.icon;
        const provenance = metadata?.flagProvenance?.[flag.id];
        return (
          <Tooltip
            className="max-w-72 text-wrap"
            content={
              <FlagProvenanceTooltip flag={flag} metadata={provenance} />
            }
            key={flag.id}
            render={
              <button
                aria-label={getFlagLabel(flag.id)}
                className="bg-background/55 focus-visible:ring-ring flex size-3 items-center justify-center rounded-full opacity-100 backdrop-blur-[2px] outline-none focus-visible:ring-1"
                data-row-expansion-ignore
                onClick={(event) => {
                  event.stopPropagation();
                  onDrop(flag.id);
                }}
                style={{ color: flag.color }}
                type="button"
              />
            }
          >
            <Icon className="size-2.5" strokeWidth={2.5} />
          </Tooltip>
        );
      })}
    </div>
  );
};

type CellLockBadgeProps = {
  provenance: LockProvenance | undefined;
  onUnlock: () => void;
};

const CellLockBadge = ({ provenance, onUnlock }: CellLockBadgeProps) => {
  const t = useTranslations();
  const locale = useLocale();
  const displayName = provenance?.lockedByName ?? null;
  const relativeTime = provenance
    ? formatRelativeTime(provenance.lockedAt, locale)
    : null;

  const tooltipContent = provenance ? (
    <span className="flex min-w-0 items-center gap-2">
      <UserAvatar
        className="size-5 shrink-0 text-[8px]"
        image={provenance.lockedByImage}
        name={displayName}
      />
      <span className="min-w-0">
        <span className="block truncate font-medium">
          {t("workspaces.table.lock.locked")}
        </span>
        <span className="text-muted-foreground block truncate text-xs">
          {displayName ? `${displayName} · ${relativeTime}` : relativeTime}
        </span>
      </span>
    </span>
  ) : (
    <span>{t("workspaces.table.lock.locked")}</span>
  );

  return (
    <Tooltip
      className="max-w-72 text-wrap"
      content={tooltipContent}
      render={
        <button
          aria-label={t("workspaces.table.lock.unlock")}
          className="bg-background/55 text-foreground-ghost focus-visible:ring-ring absolute start-1 top-1 z-20 flex size-3 items-center justify-center rounded-full backdrop-blur-[2px] outline-none focus-visible:ring-1"
          data-row-expansion-ignore
          onClick={(event) => {
            event.stopPropagation();
            onUnlock();
          }}
          type="button"
        >
          <LockIcon className="size-2.5" strokeWidth={2.5} />
        </button>
      }
    />
  );
};

type FlagProvenanceTooltipProps = {
  flag: CellFlagDefinition;
  metadata: FlagProvenance | undefined;
};

const FlagProvenanceTooltip = ({
  flag,
  metadata,
}: FlagProvenanceTooltipProps) => {
  const getFlagLabel = useFlagLabel();
  const locale = useLocale();
  const displayName = metadata?.addedByName ?? null;
  const relativeTime = metadata
    ? formatRelativeTime(metadata.addedAt, locale)
    : null;
  const label = getFlagLabel(flag.id);

  if (!metadata) {
    return <span>{label}</span>;
  }

  return (
    <span className="flex min-w-0 items-center gap-2">
      <UserAvatar
        className="size-5 shrink-0 text-[8px]"
        image={metadata.addedByImage}
        name={displayName}
      />
      <span className="min-w-0">
        <span className="block truncate font-medium">{label}</span>
        <span className="text-muted-foreground block truncate text-xs">
          {displayName ? `${displayName} · ${relativeTime}` : relativeTime}
        </span>
      </span>
    </span>
  );
};

export const CellLockMenuItem = ({
  workspaceId,
  entityId,
  propertyId,
  metadata,
}: CellMetadataFlagsProps) => {
  const t = useTranslations();
  const { isLocked, setLocked } = useCellMetadataFlags({
    entityId,
    metadata,
    propertyId,
    workspaceId,
  });

  return (
    <MenuItem onClick={() => setLocked(!isLocked)}>
      {isLocked ? <LockOpenIcon /> : <LockIcon />}
      {isLocked
        ? t("workspaces.table.lock.unlock")
        : t("workspaces.table.lock.lock")}
    </MenuItem>
  );
};

export const CellMetadataMenuSection = ({
  workspaceId,
  entityId,
  propertyId,
  metadata,
}: CellMetadataFlagsProps) => {
  const t = useTranslations();
  const { activeFlags, clearFlags, toggleFlag } = useCellMetadataFlags({
    entityId,
    metadata,
    propertyId,
    workspaceId,
  });

  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>{t("workspaces.table.flagCell")}</MenuGroupLabel>
        {CELL_FLAGS.map((flag) => {
          const Icon = flag.icon;
          const checked = activeFlags.some((f) => f.id === flag.id);
          return (
            <MenuItem
              className="min-h-7 py-0.5 text-sm"
              closeOnClick={false}
              key={flag.id}
              onClick={() => toggleFlag(flag.id)}
            >
              <Icon
                className="size-3.5 shrink-0 opacity-75"
                style={{ color: flag.color }}
              />
              <span className="min-w-0 flex-1 truncate">
                {t(FLAG_LABEL_KEYS[flag.id])}
              </span>
              {checked && (
                <CheckIcon className="text-muted-foreground ms-3 size-3.5 shrink-0" />
              )}
            </MenuItem>
          );
        })}
      </MenuGroup>
      {activeFlags.length > 0 && (
        <>
          <MenuSeparator />
          <MenuItem className="min-h-7 py-0.5 text-sm" onClick={clearFlags}>
            <XIcon className="size-3.5 shrink-0 opacity-75" />
            <span className="min-w-0 flex-1 truncate">
              {t("workspaces.table.clearFlags")}
            </span>
          </MenuItem>
        </>
      )}
    </>
  );
};

const useCellMetadataFlags = ({
  workspaceId,
  entityId,
  propertyId,
  metadata,
}: CellMetadataFlagsProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const key = cellOverrideKey(entityId, propertyId);
  const override = useCellMetadataOverridesStore(
    (state) => state.overrides[key],
  );
  const setOverride = useCellMetadataOverridesStore(
    (state) => state.setOverride,
  );
  const clearOverride = useCellMetadataOverridesStore(
    (state) => state.clearOverride,
  );

  const metadataManualFlags = useMemo(
    () => normalizeManualFlags(metadata?.manualFlags ?? []),
    [metadata?.manualFlags],
  );
  const serverLocked = metadata?.locked === true;

  const currentManualFlags = override?.manualFlags ?? metadataManualFlags;
  const isLocked = override?.locked ?? serverLocked;

  // Clear the override when the server has caught up — both
  // dimensions must match (or be unset on the override side).
  useEffect(() => {
    if (override === undefined) {
      return;
    }
    const flagsMatch = haveSameFlags(override.manualFlags, metadataManualFlags);
    const lockedMatch =
      override.locked === undefined || override.locked === serverLocked;
    if (flagsMatch && lockedMatch) {
      clearOverride(key);
    }
  }, [override, metadataManualFlags, serverLocked, clearOverride, key]);

  const activeFlags = useMemo(
    () =>
      currentManualFlags.flatMap((flagId) => {
        const flag = cellFlagsById.get(flagId);
        return flag === undefined ? [] : [flag];
      }),
    [currentManualFlags],
  );
  const hasVerifiedFlag = currentManualFlags.includes(VERIFIED_FLAG_ID);

  // Refs let the debounced flush read the latest server snapshot
  // without re-creating the callback on every prop change.
  const serverBaseRef = useRef(metadataManualFlags);
  serverBaseRef.current = metadataManualFlags;

  const updateMetadata = useMutation({
    mutationFn: async ({
      baseManualFlags,
      manualFlags,
      locked,
    }: UpdateCellMetadataVariables) => {
      const response = await api
        .fields({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .metadata.patch({
          queryKey: entitiesKeys.all(workspaceId),
          entityId: toSafeId<"entity">(entityId),
          propertyId: toSafeId<"property">(propertyId),
          baseManualFlags,
          manualFlags,
          ...(locked !== undefined && { locked }),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    scope: { id: `cell-metadata:${workspaceId}:${entityId}:${propertyId}` },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: entitiesKeys.all(workspaceId),
      });
    },
    onError: (error) => {
      clearOverride(key);
      stellaToast.add({
        title: t("errors.actionFailed"),
        description:
          error instanceof Error ? error.message : t("common.unexpectedError"),
        type: "error",
      });
    },
  });

  // Coalesce rapid clicks (e.g. dropping two flags) into a single
  // request — the user sees both flags vanish immediately from the
  // optimistic store, then one mutation hits the server with the
  // final state.
  const flush = useDebouncedCallback(() => {
    const latest = useCellMetadataOverridesStore.getState().overrides[key];
    if (!latest) {
      return;
    }
    updateMetadata.mutate({
      baseManualFlags: serverBaseRef.current,
      manualFlags: latest.manualFlags,
      ...(latest.locked !== undefined && { locked: latest.locked }),
    });
  }, 200);

  // Read the latest store state inside handlers (not render-scope
  // closures) so rapid clicks compose against the most recent
  // optimistic value rather than a stale React snapshot.
  const readLatest = () => {
    const stored = useCellMetadataOverridesStore.getState().overrides[key];
    return {
      manualFlags: stored?.manualFlags ?? metadataManualFlags,
      locked: stored?.locked ?? serverLocked,
      storedLocked: stored?.locked,
    };
  };

  const writeOverride = (
    next: { manualFlags: string[]; locked?: boolean | undefined },
    options?: { immediate?: boolean },
  ) => {
    const { storedLocked } = readLatest();
    setOverride(key, {
      manualFlags: next.manualFlags,
      locked: next.locked ?? storedLocked,
    });
    flush();
    if (options?.immediate === true) {
      // Discrete actions (lock toggle, clear flags) close the menu
      // and may unmount before the 200ms debounce fires, so commit
      // the patch immediately.
      flush.flush();
    }
  };

  const toggleFlag = (flagId: CellFlagId) => {
    const { manualFlags: latestFlags, locked: latestLocked } = readLatest();
    const wasActive = latestFlags.includes(flagId);
    const nextFlags = normalizeManualFlags(
      wasActive
        ? latestFlags.filter((id) => id !== flagId)
        : [...latestFlags, flagId],
    );
    // Adding Verified locks the cell so the curated answer can't be
    // overwritten by a later AI sweep or a stray keystroke. Removing
    // Verified does not auto-unlock (user may still want it locked).
    const shouldAutoLock =
      !wasActive && flagId === VERIFIED_FLAG_ID && !latestLocked;
    writeOverride({
      manualFlags: nextFlags,
      ...(shouldAutoLock && { locked: true }),
    });
  };

  const clearFlags = () => {
    writeOverride({ manualFlags: [] }, { immediate: true });
  };

  const setLocked = (locked: boolean) => {
    const { manualFlags: latestFlags } = readLatest();
    writeOverride({ manualFlags: latestFlags, locked }, { immediate: true });
  };

  // Safety net — if the component unmounts with a pending change,
  // commit it instead of dropping the request.
  useEffect(() => () => flush.flush(), [flush]);

  const lockProvenance = metadata?.lockProvenance;

  return {
    activeFlags,
    clearFlags,
    hasVerifiedFlag,
    isLocked,
    lockProvenance,
    setLocked,
    toggleFlag,
  };
};
