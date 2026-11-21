import type { ReactNode } from "react";

import { ListItemSkeleton } from "@stll/ui/list-shell";

import { SettingsSectionPending } from "@/routes/_protected.settings/-components/settings-section.pending";

/** The sessions section (`SessionsCard`): its header over the caller's
 *  rows, with an optional header action (signing out the other devices). */
export const SessionsCardFrame = ({
  action,
  children,
}: {
  action?: ReactNode;
  children: ReactNode;
}) => (
  <SettingsSectionPending action={action} title="common.sessions">
    {children}
  </SettingsSectionPending>
);

/** Placeholder sessions while the list loads. */
const SESSION_ROWS_PENDING = [0, 1, 2] as const;

/**
 * The section while its sessions load, both as its own fallback and in the
 * profile's pending phase: one row per session (device, then address and
 * last activity, then its status).
 */
export const SessionsCardPending = () => (
  <SessionsCardFrame>
    {SESSION_ROWS_PENDING.map((index) => (
      <ListItemSkeleton index={index} key={index} trailing="text" />
    ))}
  </SessionsCardFrame>
);
