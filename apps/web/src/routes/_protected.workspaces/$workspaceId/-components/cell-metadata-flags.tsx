import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@stll/ui/components/button";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
} from "@stll/ui/components/menu";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  CheckIcon,
  CheckCircle2Icon,
  HelpCircleIcon,
  MessageSquareWarningIcon,
  ShieldAlertIcon,
  StarIcon,
} from "lucide-react";
import { useLocale, useTranslations } from "use-intl";

import Tooltip from "@/components/tooltip";
import { UserAvatar } from "@/components/user-avatar";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { formatRelativeTime } from "@/lib/relative-time";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceCellMetadata } from "@/lib/types";
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
  const getFlagLabel = useFlagLabel();
  const { decorativeFlags, hasVerifiedFlag, toggleFlag } = useCellMetadataFlags(
    {
      entityId,
      metadata,
      propertyId,
      workspaceId,
    },
  );
  const cornerFlag = decorativeFlags.at(0);
  const verifiedProvenance = metadata?.flagProvenance?.[VERIFIED_FLAG_ID];

  return (
    <>
      {cornerFlag ? (
        <CellCornerFlag
          flags={decorativeFlags}
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
              className={cn(
                "bg-background/55 focus-visible:ring-ring absolute end-1 top-1 z-20 flex size-3 items-center justify-center rounded-full backdrop-blur-[2px] transition-opacity outline-none focus-visible:ring-1",
                hasVerifiedFlag
                  ? "opacity-100"
                  : "text-muted-foreground/70 opacity-0 group-hover/cell-content:opacity-100",
              )}
              onClick={(event) => {
                event.stopPropagation();
                toggleFlag(VERIFIED_FLAG_ID);
              }}
              style={
                hasVerifiedFlag
                  ? {
                      color: VERIFIED_CELL_FLAG.color,
                    }
                  : undefined
              }
              type="button"
            />
          }
        >
          <span
            className="size-1.5 rounded-full bg-current"
            style={{
              backgroundColor: hasVerifiedFlag
                ? VERIFIED_CELL_FLAG.color
                : "currentColor",
            }}
          />
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
          const checked = metadata?.manualFlags.includes(flag.id) ?? false;
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
          <Button
            className="mx-1 mb-1 w-[calc(100%-0.5rem)] justify-start"
            onClick={(event) => {
              event.stopPropagation();
              clearFlags();
            }}
            size="xs"
            variant="ghost"
          >
            {t("workspaces.table.clearFlags")}
          </Button>
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
  const [pendingManualFlags, setPendingManualFlags] = useState<string[] | null>(
    null,
  );
  const pendingManualFlagsRef = useRef<string[] | null>(null);
  const metadataManualFlags = useMemo(
    () => normalizeManualFlags(metadata?.manualFlags ?? []),
    [metadata?.manualFlags],
  );
  const currentManualFlags = pendingManualFlags ?? metadataManualFlags;

  useEffect(() => {
    if (
      pendingManualFlags !== null &&
      haveSameFlags(pendingManualFlags, metadataManualFlags)
    ) {
      pendingManualFlagsRef.current = null;
      setPendingManualFlags(null);
    }
  }, [metadataManualFlags, pendingManualFlags]);

  const activeFlags = useMemo(
    () =>
      currentManualFlags.flatMap((flagId) => {
        const flag = cellFlagsById.get(flagId);
        return flag === undefined ? [] : [flag];
      }),
    [currentManualFlags],
  );
  const decorativeFlags = activeFlags.filter(
    (flag) => flag.id !== VERIFIED_FLAG_ID,
  );
  const hasVerifiedFlag = currentManualFlags.includes(VERIFIED_FLAG_ID);

  const updateMetadata = useMutation({
    mutationFn: async ({
      baseManualFlags,
      manualFlags,
    }: UpdateCellMetadataVariables) => {
      const response = await api
        .fields({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .metadata.patch({
          queryKey: entitiesKeys.all(workspaceId),
          entityId: toSafeId<"entity">(entityId),
          propertyId: toSafeId<"property">(propertyId),
          baseManualFlags,
          manualFlags,
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
      pendingManualFlagsRef.current = null;
      setPendingManualFlags(null);
      stellaToast.add({
        title: t("errors.actionFailed"),
        description:
          error instanceof Error ? error.message : t("common.unexpectedError"),
        type: "error",
      });
    },
  });

  const toggleFlag = (flagId: CellFlagId) => {
    const current = pendingManualFlagsRef.current ?? metadataManualFlags;
    const next = normalizeManualFlags(
      current.includes(flagId)
        ? current.filter((id) => id !== flagId)
        : [...current, flagId],
    );
    pendingManualFlagsRef.current = next;
    setPendingManualFlags(next);
    updateMetadata.mutate({ baseManualFlags: current, manualFlags: next });
  };

  const clearFlags = () => {
    const current = pendingManualFlagsRef.current ?? metadataManualFlags;
    pendingManualFlagsRef.current = [];
    setPendingManualFlags([]);
    updateMetadata.mutate({ baseManualFlags: current, manualFlags: [] });
  };

  return {
    activeFlags,
    clearFlags,
    decorativeFlags,
    hasVerifiedFlag,
    toggleFlag,
  };
};
