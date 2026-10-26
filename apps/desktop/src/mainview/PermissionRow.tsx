import type { ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Switch } from "@stll/ui/switch";

import type { Permission, PermissionRow as Row } from "../shared/permissions";

const PERMISSION_COPY = {
  accessibility: {
    description: "permissionAccessibilityDescription",
    label: "permissionAccessibility",
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

type PermissionRowProps = {
  onOpenSettings: () => void;
  onRequest: () => void;
  onTurnOff: () => void;
  row: Row;
};

/**
 * One permission: what it is for, its live status, and the action that asks
 * the OS or opens its settings. Open at login is the app's own choice, so it
 * is a switch until macOS says it needs approval in Login Items.
 */
export const PermissionRow = ({
  onOpenSettings,
  onRequest,
  onTurnOff,
  row,
}: PermissionRowProps) => {
  const t = useTranslations("settings");
  const copy = PERMISSION_COPY[row.permission];
  const switchId = `permission-${row.permission}`;
  const usesSwitch =
    row.permission === "openAtLogin" &&
    (row.status === "granted" || row.status === "notDetermined");

  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        {usesSwitch ? (
          <label className="text-sm font-medium" htmlFor={switchId}>
            {t(copy.label)}
          </label>
        ) : (
          <p className="text-sm font-medium">{t(copy.label)}</p>
        )}
        <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
          {t(copy.description)}
        </p>
        {row.status === "denied" ? (
          <p className="text-warning-foreground mt-1 text-sm">
            {t("permissionDenied")}
          </p>
        ) : null}
      </div>
      <div className="shrink-0">
        {usesSwitch ? (
          <Switch
            checked={row.status === "granted"}
            id={switchId}
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
            },
            onOpenSettings,
            onRequest,
            row,
          })
        )}
      </div>
    </div>
  );
};

type PermissionControlOptions = {
  labels: {
    allow: string;
    allowed: string;
    managed: string;
    openSettings: string;
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
      return (
        <span className="text-success-foreground text-sm font-medium">
          {labels.allowed}
        </span>
      );
    case "notDetermined":
      return (
        <Button onClick={onRequest} size="sm" variant="outline">
          {labels.allow}
        </Button>
      );
    case "denied":
      return (
        <Button onClick={onOpenSettings} size="sm" variant="outline">
          {labels.openSettings}
        </Button>
      );
    case "managed":
      return (
        <span className="text-muted-foreground max-w-40 text-end text-sm">
          {labels.managed}
        </span>
      );
    case "notApplicable":
      return null;
    default:
      row.status satisfies never;
      return panic("Unknown permission status.");
  }
}
