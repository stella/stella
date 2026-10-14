import type { ReactNode } from "react";
import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { MATTER_VISIBILITY } from "@stll/api-contract";
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
import { BuildingIcon, LockIcon } from "@stll/ui/icons";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { roleOptions } from "@/lib/auth-queries";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { notifyUserError } from "@/lib/errors/user-toast";
import { hasOrganizationManagementAccess } from "@/lib/organization/role-assignment.logic";
import { useQueryView } from "@/lib/use-query-view";
import { useUpdateWorkspace } from "@/lib/workspaces/mutations";

const VISIBILITY_ICON = {
  organization: BuildingIcon,
  private: LockIcon,
} as const satisfies Record<MatterVisibility, unknown>;

/**
 * Create-matter choice of who can see the matter. Two radio rows: the label
 * carries the meaning and the description says exactly who that is.
 */
export const MatterVisibilityChoice = ({
  value,
  onChange,
}: {
  value: MatterVisibility;
  onChange: (value: MatterVisibility) => void;
}) => {
  const t = useTranslations();
  const options = [
    {
      value: MATTER_VISIBILITY.organization,
      label: t("workspaces.team"),
      description: t("workspaces.visibility.organizationDescription"),
    },
    {
      value: MATTER_VISIBILITY.private,
      label: t("workspaces.visibility.private"),
      description: t("workspaces.visibility.privateDescription"),
    },
  ] as const;

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">
        {t("workspaces.visibility.label")}
      </legend>
      <div className="divide-y overflow-hidden rounded-lg border">
        {options.map((option) => {
          const Icon = VISIBILITY_ICON[option.value];
          const checked = value === option.value;
          return (
            <label
              aria-label={option.label}
              className={cn(
                "grid min-h-11 cursor-pointer grid-cols-[1rem_minmax(0,1fr)] items-start gap-2.5 px-3 py-2.5",
                checked && "bg-muted/60",
              )}
              key={option.value}
            >
              <input
                checked={checked}
                className="accent-primary mt-0.5 size-4"
                name="matter-visibility"
                onChange={() => onChange(option.value)}
                type="radio"
                value={option.value}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Icon className="text-muted-foreground size-3.5" />
                  {option.label}
                </span>
                <span className="text-muted-foreground text-xs text-pretty">
                  {option.description}
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
 * Marks a private matter in matter lists. Organization is the norm, so an
 * organization matter carries no badge.
 */
export const PrivateMatterBadge = ({
  visibility,
}: {
  visibility: MatterVisibility;
}) => {
  const t = useTranslations();
  if (visibility !== MATTER_VISIBILITY.private) {
    return null;
  }
  return (
    <span
      className="text-muted-foreground text-2xs inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 leading-4 font-medium"
      title={t("workspaces.visibility.privateBadgeTitle")}
    >
      <LockIcon aria-hidden className="size-2.5" />
      {t("workspaces.visibility.private")}
    </span>
  );
};

type VisibilitySectionProps = {
  workspaceId: string;
  matterName: string;
  visibility: MatterVisibility;
  leadUserId: string | null;
};

/**
 * Matter-settings row for who can see the matter. The matter lead and
 * organization owners and admins may change it; opening a private matter to
 * the organization asks first, since it exposes the matter's contents.
 */
export const VisibilitySection = ({
  workspaceId,
  matterName,
  visibility,
  leadUserId,
}: VisibilitySectionProps) => {
  const t = useTranslations();
  const currentUser = useAuthenticatedUser();
  const roleView = useQueryView(
    useQuery({ ...roleOptions, staleTime: Number.POSITIVE_INFINITY }),
  );
  const role =
    roleView.type === "items" && roleView.refetchError === undefined
      ? roleView.items
      : undefined;
  const updateWorkspace = useUpdateWorkspace();
  const [confirmingOpen, setConfirmingOpen] = useState(false);
  // The server decides; this only keeps the control from inviting a change
  // it would refuse.
  const canChange =
    leadUserId === currentUser.id || hasOrganizationManagementAccess(role);

  const save = (next: MatterVisibility) => {
    updateWorkspace.mutate(
      { workspaceId, update: { type: "visibility", value: next } },
      {
        onSuccess: () => {
          setConfirmingOpen(false);
          stellaToast.add({
            title:
              next === MATTER_VISIBILITY.organization
                ? t("workspaces.visibility.madeOrganization")
                : t("workspaces.visibility.madePrivate"),
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
    if (next === MATTER_VISIBILITY.organization) {
      setConfirmingOpen(true);
      return;
    }
    save(next);
  };

  const summary =
    visibility === MATTER_VISIBILITY.organization
      ? t("workspaces.visibility.organizationSummary")
      : t("workspaces.visibility.privateSummary");

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
            if (
              value === MATTER_VISIBILITY.organization ||
              value === MATTER_VISIBILITY.private
            ) {
              handleSelect(value);
            }
          }}
          value={visibility}
        >
          <SelectTrigger className="min-w-0 flex-1">
            <SelectValue>
              {(current) =>
                current === MATTER_VISIBILITY.private
                  ? t("workspaces.visibility.private")
                  : t("workspaces.team")
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={MATTER_VISIBILITY.organization}>
              {t("workspaces.team")}
            </SelectItem>
            <SelectItem value={MATTER_VISIBILITY.private}>
              {t("workspaces.visibility.private")}
            </SelectItem>
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
            setConfirmingOpen(false);
          }
        }}
        open={confirmingOpen}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("workspaces.visibility.confirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t.rich("workspaces.visibility.confirmDescription", {
                bdi: (chunks: ReactNode) => (
                  <BidiText className="font-medium">{chunks}</BidiText>
                ),
                matterName,
              })}
            </AlertDialogDescription>
            <p className="text-muted-foreground text-xs text-pretty">
              {t("workspaces.visibility.confirmNote")}
            </p>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              disabled={updateWorkspace.isPending}
              onClick={() => setConfirmingOpen(false)}
              variant="ghost"
            >
              {t("workspaces.visibility.confirmCancel")}
            </Button>
            <Button
              loading={updateWorkspace.isPending}
              onClick={() => save(MATTER_VISIBILITY.organization)}
            >
              {t("workspaces.visibility.confirmAction")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
};
