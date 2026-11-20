import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";

import { PendingText } from "@/components/pending-text";

/*
 * The activity-log archive (`./organization-audit-archive.tsx`): one line on
 * why an owner keeps one, over the archive's state. The archive renders
 * `OrganizationAuditArchiveFrame` with its state; while that state is read,
 * the danger zone shows `OrganizationAuditArchivePending`, the line over the
 * face of the request action an organization without an archive gets.
 */

/** The archive in both phases: the line over its state. */
export const OrganizationAuditArchiveFrame = ({
  children,
}: {
  /** The archive's state (its action, its progress), or the action's face. */
  children: ReactNode;
}) => (
  <div className="flex flex-col gap-3">
    <p className="text-muted-foreground text-sm">
      <PendingText
        barClassName="w-80 max-w-full"
        id="admin.auditArchiveDescription"
      />
    </p>
    {children}
  </div>
);

/** The archive while its state is read. */
export const OrganizationAuditArchivePending = () => (
  <OrganizationAuditArchiveFrame>
    <div>
      <ButtonFace size="sm" variant="outline">
        <FaceLabelPending className="w-28" />
      </ButtonFace>
    </div>
  </OrganizationAuditArchiveFrame>
);
