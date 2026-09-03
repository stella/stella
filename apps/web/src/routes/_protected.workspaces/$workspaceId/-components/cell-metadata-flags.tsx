import { useLayoutEffect, useMemo, useRef } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2Icon, LockIcon, LockOpenIcon, XIcon } from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { isReviewFlag, REVIEW_FLAG } from "@stll/api-contract";
import type { ReviewFlag } from "@stll/api-contract";
import { BidiText } from "@stll/ui/bidi-text";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
} from "@stll/ui/menu";
import { stellaToast } from "@stll/ui/toast";
import { useLatest } from "@stll/ui/use-latest";

import {
  REVIEW_FLAG_PRESENTATION,
  ReviewFlagMenuItems,
  useReviewFlagLabel,
} from "@/components/review-flags";
import Tooltip from "@/components/tooltip";
import { UserAvatar } from "@/components/user-avatar";
import { useMountEffect } from "@/hooks/use-effect";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { formatRelativeTime } from "@/lib/relative-time";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceCellMetadata } from "@/lib/types";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";
import {
  cellOverrideKey,
  useCellMetadataOverridesStore,
} from "@/routes/_protected.workspaces/$workspaceId/-components/cell-metadata-overrides-store";

const NO_MANUAL_FLAGS: readonly ReviewFlag[] = Object.freeze([]);

const VERIFIED_FLAG_ID = REVIEW_FLAG.VERIFIED;

// One vocabulary, one presentation: the cell corner, the cell menu and the
// review finding card all read `REVIEW_FLAG_PRESENTATION`.
type CellFlagId = ReviewFlag;

type CellFlagDefinition = (typeof REVIEW_FLAG_PRESENTATION)[CellFlagId] & {
  id: CellFlagId;
};

const cellFlagDefinition = (id: CellFlagId): CellFlagDefinition => ({
  ...REVIEW_FLAG_PRESENTATION[id],
  id,
});

const VERIFIED_CELL_FLAG = cellFlagDefinition(VERIFIED_FLAG_ID);

export const getCellFlagById = (
  flagId: string,
): CellFlagDefinition | undefined =>
  isReviewFlag(flagId) ? cellFlagDefinition(flagId) : undefined;

// Determines which active flag colors the cell background tint when
// several flags coexist. Verified wins (the desired final state),
// then the most pressing review/issue flags.
const TINT_PRIORITY = [
  "verified",
  "contradiction",
  "follow-up",
  "needs-review",
  "important",
] as const satisfies readonly CellFlagId[];

type MissingTintPriority = Exclude<CellFlagId, (typeof TINT_PRIORITY)[number]>;

true satisfies MissingTintPriority extends never ? true : never;

type FlagProvenance = NonNullable<
  WorkspaceCellMetadata["flagProvenance"]
>[string];

type LockProvenance = NonNullable<WorkspaceCellMetadata["lockProvenance"]>;

export const useFlagLabel = useReviewFlagLabel;

const normalizeManualFlags = (flags: readonly ReviewFlag[]): ReviewFlag[] =>
  [...new Set(flags)].toSorted();

const haveSameFlags = (
  a: readonly ReviewFlag[],
  b: readonly ReviewFlag[],
): boolean =>
  a.length === b.length && a.every((flag, index) => flag === b[index]);

type UpdateCellMetadataVariables = {
  baseManualFlags: ReviewFlag[];
  manualFlags: ReviewFlag[];
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
    isLocked,
    lockProvenance,
    setLocked,
    tintFlag,
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
      {tintFlag && (
        <span
          aria-hidden
          // Negative z-index keeps the tint behind cell text. The
          // parent WorkspaceGridCell sets `relative z-0`, which
          // creates a stacking context so this stays scoped to the
          // cell.
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundColor: tintFlag.background,
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
          <LockOpenIcon className="size-2.5" strokeWidth={2.5} />
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
  const displayName = provenance?.lockedByName ?? null;
  const relativeTime = provenance
    ? formatRelativeTime(provenance.lockedAt)
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
          {displayName ? (
            <>
              <BidiText>{displayName}</BidiText>
              {" · "}
              {relativeTime}
            </>
          ) : (
            relativeTime
          )}
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
          className="bg-background/55 text-foreground focus-visible:ring-ring animate-in fade-in-0 zoom-in-75 absolute start-1 top-1 z-20 flex size-3 items-center justify-center rounded-full backdrop-blur-[2px] duration-150 outline-none focus-visible:ring-1 motion-reduce:animate-none"
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
  const displayName = metadata?.addedByName ?? null;
  const relativeTime = metadata ? formatRelativeTime(metadata.addedAt) : null;
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
          {displayName ? (
            <>
              <BidiText>{displayName}</BidiText>
              {" · "}
              {relativeTime}
            </>
          ) : (
            relativeTime
          )}
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
        <ReviewFlagMenuItems
          active={activeFlags.map((flag) => flag.id)}
          onToggle={toggleFlag}
        />
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

export const useCellMetadataFlags = ({
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

  const serverManualFlags = metadata?.manualFlags;
  const metadataManualFlags = useMemo(
    () => normalizeManualFlags(serverManualFlags ?? NO_MANUAL_FLAGS),
    [serverManualFlags],
  );
  const serverLocked = metadata?.locked === true;

  const currentManualFlags = override?.manualFlags ?? metadataManualFlags;
  const isLocked = override?.locked ?? serverLocked;

  useLayoutEffect(() => {
    const store = useCellMetadataOverridesStore.getState();
    const latestOverride = store.overrides[key];
    if (latestOverride === undefined) {
      return;
    }
    const flagsMatch = haveSameFlags(
      latestOverride.manualFlags,
      metadataManualFlags,
    );
    const lockedMatch =
      latestOverride.locked === undefined ||
      latestOverride.locked === serverLocked;
    if (flagsMatch && lockedMatch) {
      store.clearOverride(key);
    }
  }, [key, metadataManualFlags, override, serverLocked]);

  const activeFlags = useMemo(
    () =>
      currentManualFlags.flatMap((flagId) => {
        const flag = getCellFlagById(flagId);
        return flag === undefined ? [] : [flag];
      }),
    [currentManualFlags],
  );
  const hasVerifiedFlag = currentManualFlags.includes(VERIFIED_FLAG_ID);
  const tintFlag = useMemo(
    () =>
      TINT_PRIORITY.flatMap((flagId) => {
        if (!currentManualFlags.includes(flagId)) {
          return [];
        }
        const flag = getCellFlagById(flagId);
        return flag === undefined ? [] : [flag];
      }).at(0) ?? null,
    [currentManualFlags],
  );

  // Refs let the debounced flush read the latest server snapshot
  // without re-creating the callback on every prop change.
  const serverBaseRef = useLatest(metadataManualFlags);
  // Tracks the flag set most recently sent to the server. Used as
  // the merge base for the next flush so a rapid add-then-remove
  // diffs against the in-flight value rather than the now-stale
  // server snapshot.
  const lastSentRef = useRef<ReviewFlag[] | null>(null);

  // Once the server-side metadata catches up with what we last sent,
  // drop the in-flight base so the next flush diffs against the
  // server again.
  useLayoutEffect(() => {
    if (
      lastSentRef.current !== null &&
      haveSameFlags(lastSentRef.current, metadataManualFlags)
    ) {
      lastSentRef.current = null;
    }
  }, [metadataManualFlags]);

  const updateMetadata = useMutation({
    mutationFn: async ({
      baseManualFlags,
      manualFlags,
      locked,
    }: UpdateCellMetadataVariables) => {
      const response = await api
        .fields({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .metadata.patch({
          entityId: toSafeId<"entity">(entityId),
          propertyId: toSafeId<"property">(propertyId),
          baseManualFlags,
          manualFlags,
          ...(locked !== undefined && { locked }),
        });

      return unwrapEden(response);
    },
    scope: { id: `cell-metadata:${workspaceId}:${entityId}:${propertyId}` },
    onSuccess: () => {
      detached(
        queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(workspaceId),
        }),
        "cell-metadata-flags.invalidate",
      );
    },
    onError: (error) => {
      lastSentRef.current = null;
      clearOverride(key);
      stellaToast.add({
        title: t("errors.actionFailed"),
        description: userErrorFromThrown(error, t("common.unexpectedError")),
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
    const baseManualFlags = lastSentRef.current ?? serverBaseRef.current;
    lastSentRef.current = latest.manualFlags;
    updateMetadata.mutate({
      baseManualFlags,
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
    next: { manualFlags: ReviewFlag[]; locked?: boolean | undefined },
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
  // commit it instead of dropping the request. `flush` is a stable
  // `useDebouncedCallback` reference, so a mount-scoped cleanup
  // captures the same instance the handlers call.
  useMountEffect(() => () => flush.flush());

  const lockProvenance = metadata?.lockProvenance;

  return {
    activeFlags,
    clearFlags,
    hasVerifiedFlag,
    isLocked,
    lockProvenance,
    setLocked,
    tintFlag,
    toggleFlag,
  };
};
