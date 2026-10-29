import type { ReactNode } from "react";
import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  MATTER_VISIBILITIES,
  MATTER_VISIBILITY,
  widensMatterVisibility,
} from "@stll/api-contract";
import type { MatterVisibility } from "@stll/api-contract";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/alert-dialog";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { BuildingIcon, LockIcon, UsersIcon } from "@stll/ui/icons";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { usePermissions } from "@/hooks/use-permissions";
import type { TranslationKey } from "@/i18n/types";
import { roleOptions } from "@/lib/auth-queries";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { notifyUserError } from "@/lib/errors/user-toast";
import { hasOrganizationManagementAccess } from "@/lib/organization/role-assignment.logic";
import { queryView } from "@/lib/query-view.logic";
import { useUpdateWorkspace } from "@/lib/workspaces/mutations";

/** Copy and icon for each level, widest first (the order MATTER_VISIBILITIES lists). */
const VISIBILITY_COPY = {
  all_members: {
    icon: UsersIcon,
    label: "workspaces.visibility.allMembers",
    description: "workspaces.visibility.allMembersDescription",
    summary: "workspaces.visibility.allMembersSummary",
  },
  admins_and_assigned: {
    icon: BuildingIcon,
    label: "workspaces.visibility.adminsAndAssigned",
    description: "workspaces.visibility.adminsAndAssignedDescription",
    summary: "workspaces.visibility.adminsAndAssignedSummary",
  },
  assigned_only: {
    icon: LockIcon,
    label: "workspaces.visibility.assignedOnly",
    description: "workspaces.visibility.assignedOnlyDescription",
    summary: "workspaces.visibility.assignedOnlySummary",
  },
} as const satisfies Record<
  MatterVisibility,
  {
    icon: unknown;
    label: TranslationKey;
    description: TranslationKey;
    summary: TranslationKey;
  }
>;

/** What widening to a level exposes, named in the confirm step. */
const WIDEN_DESCRIPTION = {
  all_members: "workspaces.visibility.confirmDescriptionAllMembers",
  admins_and_assigned: "workspaces.visibility.confirmDescriptionAdmins",
  assigned_only: null,
} as const satisfies Record<MatterVisibility, TranslationKey | null>;

const isMatterVisibility = (value: unknown): value is MatterVisibility =>
  MATTER_VISIBILITIES.some((visibility) => visibility === value);

/**
 * Create-matter choice of who can see the matter. One radio row per level:
 * the label carries the meaning and the description says exactly who that is.
 */
export const MatterVisibilityChoice = ({
  value,
  onChange,
}: {
  value: MatterVisibility;
  onChange: (value: MatterVisibility) => void;
}) => {
  const t = useTranslations();

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">
        {t("workspaces.visibility.label")}
      </legend>
      <div className="divide-y overflow-hidden rounded-lg border">
        {MATTER_VISIBILITIES.map((option) => {
          const copy = VISIBILITY_COPY[option];
          const Icon = copy.icon;
          const checked = value === option;
          return (
            <label
              aria-label={t(copy.label)}
              className={cn(
                "grid min-h-11 cursor-pointer grid-cols-[1rem_minmax(0,1fr)] items-start gap-2.5 px-3 py-2.5",
                checked && "bg-muted/60",
              )}
              key={option}
            >
              <input
                checked={checked}
                className="accent-primary mt-0.5 size-4"
                name="matter-visibility"
                onChange={() => onChange(option)}
                type="radio"
                value={option}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Icon className="text-muted-foreground size-3.5" />
                  {t(copy.label)}
                </span>
                <span className="text-muted-foreground text-xs text-pretty">
                  {t(copy.description)}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
};

/**
 * Marks the two non-default levels in matter lists: a matter every internal
 * member can open, and one only its assigned members can. The default level
 * carries no badge.
 */
export const MatterVisibilityBadge = ({
  visibility,
}: {
  visibility: MatterVisibility;
}) => {
  const t = useTranslations();
  const badge = (() => {
    switch (visibility) {
      case MATTER_VISIBILITY.allMembers:
        return {
          Icon: UsersIcon,
          label: t("workspaces.visibility.badgeAllMembers"),
          title: t("workspaces.visibility.badgeAllMembersTitle"),
        };
      case MATTER_VISIBILITY.assignedOnly:
        return {
          Icon: LockIcon,
          label: t("workspaces.visibility.badgeAssignedOnly"),
          title: t("workspaces.visibility.badgeAssignedOnlyTitle"),
        };
      case MATTER_VISIBILITY.adminsAndAssigned:
        return null;
      default:
        visibility satisfies never;
        return panic(`Unhandled matter visibility: ${String(visibility)}`);
    }
  })();
  if (badge === null) {
    return null;
  }
  return (
    <span
      className="text-muted-foreground text-2xs inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 leading-4 font-medium"
      title={badge.title}
    >
      <badge.Icon aria-hidden className="size-2.5" />
      {badge.label}
    </span>
  );
};

/**
 * Whether the signed-in user may change a matter's visibility or lead: its
 * current lead, or a team owner/admin. The server decides; this only keeps
 * the controls from inviting a change it would refuse.
 */
export const useCanStewardMatter = (leadUserId: string | null): boolean => {
  const currentUser = useAuthenticatedUser();
  const roleView = queryView(
    useQuery({ ...roleOptions, staleTime: Number.POSITIVE_INFINITY }),
  );
  const role =
    roleView.type === "items" && roleView.refetchError === undefined
      ? roleView.items
      : undefined;
  return leadUserId === currentUser.id || hasOrganizationManagementAccess(role);
};

type VisibilitySectionProps = {
  workspaceId: string;
  matterName: string;
  visibility: MatterVisibility;
  leadUserId: string | null;
};

/**
 * Matter-settings row for who can see the matter. The matter lead and team
 * owners and admins may change it; any change that shows the matter to more
 * people asks first, since it exposes the matter's contents.
 */
export const VisibilitySection = ({
  workspaceId,
  matterName,
  visibility,
  leadUserId,
}: VisibilitySectionProps) => {
  const t = useTranslations();
  const updateWorkspace = useUpdateWorkspace();
  const canUpdate = usePermissions({ workspace: ["update"] });
  const canSteward = useCanStewardMatter(leadUserId);
  const canChange = canUpdate && canSteward;
  const [pendingWiden, setPendingWiden] = useState<MatterVisibility | null>(
    null,
  );

  const save = (next: MatterVisibility) => {
    updateWorkspace.mutate(
      { workspaceId, update: { type: "visibility", value: next } },
      {
        onSuccess: () => {
          setPendingWiden(null);
          stellaToast.add({
            title: t("workspaces.visibility.updated"),
            type: "success",
          });
        },
        onError: (error) => {
          notifyUserError(error, t("errors.actionFailed"));
        },
      },
    );
  };

  const handleSelect = (next: MatterVisibility) => {
    if (next === visibility) {
      return;
    }
    if (widensMatterVisibility(visibility, next)) {
      setPendingWiden(next);
      return;
    }
    save(next);
  };

  const summary = t(VISIBILITY_COPY[visibility].summary);
  const widenDescription =
    pendingWiden === null ? null : WIDEN_DESCRIPTION[pendingWiden];

  return (
    <section className="grid shrink-0 grid-cols-[8rem_minmax(0,1fr)] items-center gap-x-3 border-b px-3">
      <span className="text-muted-foreground truncate text-sm font-medium">
        {t("workspaces.visibility.settingLabel")}
      </span>
      <div
        className={cn("flex min-w-0 items-center gap-2", TOOLBAR_ROW_HEIGHT)}
      >
        <Select
          disabled={!canChange || updateWorkspace.isPending}
          onValueChange={(value) => {
            if (isMatterVisibility(value)) {
              handleSelect(value);
            }
          }}
          value={visibility}
        >
          <SelectTrigger className="min-w-0 flex-1">
            <SelectValue>
              {(current) =>
                isMatterVisibility(current)
                  ? t(VISIBILITY_COPY[current].label)
                  : null
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {MATTER_VISIBILITIES.map((option) => (
              <SelectItem key={option} value={option}>
                {t(VISIBILITY_COPY[option].label)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <p className="text-muted-foreground col-start-2 pb-2 text-xs text-pretty">
        {canChange
          ? summary
          : t("workspaces.visibility.summaryReadOnly", { summary })}
      </p>
      <AlertDialog
        onOpenChange={(open) => {
          if (!open && !updateWorkspace.isPending) {
            setPendingWiden(null);
          }
        }}
        open={pendingWiden !== null}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("workspaces.visibility.confirmTitle")}
            </AlertDialogTitle>
            {widenDescription === null ? null : (
              <AlertDialogDescription>
                {t.rich(widenDescription, {
                  bdi: (chunks: ReactNode) => (
                    <BidiText className="font-medium">{chunks}</BidiText>
                  ),
                  matterName,
                })}
              </AlertDialogDescription>
            )}
            <p className="text-muted-foreground text-xs text-pretty">
              {t("workspaces.visibility.confirmNote")}
            </p>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              disabled={updateWorkspace.isPending}
              onClick={() => setPendingWiden(null)}
              variant="ghost"
            >
              {t("workspaces.visibility.confirmCancel")}
            </Button>
            <Button
              loading={updateWorkspace.isPending}
              onClick={() => {
                if (pendingWiden !== null) {
                  save(pendingWiden);
                }
              }}
            >
              {t("workspaces.visibility.confirmAction")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
};
