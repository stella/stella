import type { ReactNode } from "react";

import { ButtonFace } from "@stll/ui/control-face";
import { SettingsPanel } from "@stll/ui/settings";

import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";
import { SettingsSectionPending } from "@/routes/_protected.settings/-components/settings-section.pending";

import { OrganizationAuditArchivePending } from "./organization-audit-archive.pending";

/*
 * The organization's danger zone (`./organization-danger-zone.tsx`): its
 * heading over one surface of rows, each a line on what the action does and the
 * action at the end. Every manager can leave; an owner also gets the
 * activity-log archive and deletion. The section renders
 * `OrganizationDangerZoneSection` and `OrganizationDangerZoneRow`; the
 * General page's pending phase renders `OrganizationDangerZonePending`, the
 * same rows with the actions' faces.
 */

/** The section in both phases: its heading over the surface of rows. */
export const OrganizationDangerZoneSection = ({
  children,
}: {
  children: ReactNode;
}) => (
  <SettingsSectionPending
    title="settings.account.dangerZone"
    tone="destructive"
  >
    <SettingsPanel>
      <div className="flex flex-col gap-5">{children}</div>
    </SettingsPanel>
  </SettingsSectionPending>
);

/** One action's row: its line, then the action. */
export const OrganizationDangerZoneRow = ({
  action,
  description,
}: {
  description: PendingTextKey;
  /** The action's button, or its face. */
  action: ReactNode;
}) => (
  <div className="flex flex-wrap items-center justify-between gap-3">
    <p className="text-muted-foreground text-sm">
      <PendingText barClassName="w-96 max-w-full" id={description} />
    </p>
    {action}
  </div>
);

/**
 * The section before the page mounts: leaving, and for an owner the archive
 * and deletion, with the actions' faces. Whether the member is an owner
 * comes from the role the cache holds; without one, the owner's rows join
 * at the end of the page once it mounts.
 */
export const OrganizationDangerZonePending = ({
  isOwner,
}: {
  isOwner: boolean;
}) => (
  <OrganizationDangerZoneSection>
    <OrganizationDangerZoneRow
      action={
        <ButtonFace size="default" variant="outline">
          <PendingText barClassName="w-28" id="admin.leaveOrganization" />
        </ButtonFace>
      }
      description="admin.leaveDescription"
    />
    {isOwner && <OrganizationAuditArchivePending />}
    {isOwner && (
      <OrganizationDangerZoneRow
        action={
          <ButtonFace size="default" variant="destructive">
            <PendingText barClassName="w-32" id="admin.deleteOrganization" />
          </ButtonFace>
        }
        description="admin.deleteDescription"
      />
    )}
  </OrganizationDangerZoneSection>
);
