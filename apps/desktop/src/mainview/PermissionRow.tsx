import type { ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  AccessibilityIcon,
  BellIcon,
  DictateIcon,
  PowerIcon,
} from "@stll/ui/icons";
import type { LucideIcon } from "@stll/ui/icons";
import {
  ListItemActions,
  ListItemContent,
  ListItemDescription,
  ListItemMedia,
  ListItemStatus,
  ListItemTitle,
} from "@stll/ui/list";
import { Switch } from "@stll/ui/switch";

import type { Permission, PermissionRow as Row } from "../shared/permissions";

const PERMISSION_COPY = {
  accessibility: {
    description: "permissionAccessibilityDescription",
    label: "permissionAccessibility",
  },
  microphone: {
    description: "permissionMicrophoneDescription",
    label: "permissionMicrophone",
  },
  notifications: {
    description: "permissionNotificationsDescription",
    label: "notifications",
  },
  openAtLogin: {
    description: "startOnLoginDescription",
    label: "startOnLogin",
  },
} as const satisfies Record<Permission, { description: string; label: string }>;

const PERMISSION_ICONS = {
  accessibility: AccessibilityIcon,
  microphone: DictateIcon,
  notifications: BellIcon,
  openAtLogin: PowerIcon,
} as const satisfies Record<Permission, LucideIcon>;

/** Whether a row leads with its permission's icon tile. Rows mixed in with
 *  other settings that have none go without. */
export type PermissionRowMedia = "icon" | "none";

type PermissionRowProps = {
  /** Replaces the usual purpose where one feature asks for the permission. */
  description?: string | undefined;
  onOpenSettings: () => void;
  onRequest: () => void;
  onTurnOff: () => void;
  media: PermissionRowMedia;
  row: Row;
};

/**
 * One permission: an icon tile, what it unlocks, its live status as a dot
 * and a label, and the one action that asks the OS or opens its settings.
 * Open at login is the app's own choice, so it is a switch until macOS says
 * it needs approval in Login Items.
 */
export const PermissionRow = ({
  description,
  media,
  onOpenSettings,
  onRequest,
  onTurnOff,
  row,
}: PermissionRowProps) => {
  const t = useTranslations("settings");
  const copy = PERMISSION_COPY[row.permission];
  const Icon = PERMISSION_ICONS[row.permission];
  const labelId = `permission-${row.permission}-label`;
  const descriptionId = `permission-${row.permission}-description`;
  const usesSwitch =
    row.permission === "openAtLogin" &&
    (row.status === "granted" || row.status === "notDetermined");

  return (
    <div
      className="flex min-h-14 items-center gap-3 px-4 py-2.5"
      data-permission={row.permission}
    >
      {media === "icon" ? (
        <ListItemMedia>
          <Icon />
        </ListItemMedia>
      ) : null}
      <ListItemContent>
        <ListItemTitle id={labelId} variant="statement">
          {t(copy.label)}
        </ListItemTitle>
        <ListItemDescription id={descriptionId} variant="paragraph">
          {description ?? t(copy.description)}
        </ListItemDescription>
      </ListItemContent>
      <ListItemActions>
        {usesSwitch ? (
          <Switch
            aria-describedby={descriptionId}
            aria-labelledby={labelId}
            checked={row.status === "granted"}
            onCheckedChange={(checked) => {
              if (checked) {
                onRequest();
                return;
              }
              onTurnOff();
            }}
          />
        ) : (
          permissionControl({
            labels: {
              allow: t("permissionAllow"),
              allowed: t("permissionAllowed"),
              managed: t("permissionManaged"),
              openSettings: t("permissionOpenSettings"),
              turnedOff: t("permissionTurnedOff"),
            },
            onOpenSettings,
            onRequest,
            row,
          })
        )}
      </ListItemActions>
    </div>
  );
};

type PermissionControlOptions = {
  labels: {
    allow: string;
    allowed: string;
    managed: string;
    openSettings: string;
    turnedOff: string;
  };
  onOpenSettings: () => void;
  onRequest: () => void;
  row: Row;
};

function permissionControl({
  labels,
  onOpenSettings,
  onRequest,
  row,
}: PermissionControlOptions): ReactNode {
  switch (row.status) {
    case "granted":
      return <ListItemStatus tone="success">{labels.allowed}</ListItemStatus>;
    case "notDetermined":
      return (
        <Button onClick={onRequest} variant="outline">
          {labels.allow}
        </Button>
      );
    case "denied":
      return (
        <>
          <ListItemStatus tone="warning">{labels.turnedOff}</ListItemStatus>
          <Button onClick={onOpenSettings} variant="outline">
            {labels.openSettings}
          </Button>
        </>
      );
    case "managed":
      return <ListItemStatus>{labels.managed}</ListItemStatus>;
    case "notApplicable":
      return null;
    default:
      row.status satisfies never;
      return panic("Unknown permission status.");
  }
}
