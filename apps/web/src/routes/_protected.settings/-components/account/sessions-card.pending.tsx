import type { ReactNode } from "react";

import { FaceLabelPending } from "@stll/ui/control-face";
import { FramePanel } from "@stll/ui/frame";

import { SettingsCardPending } from "@/routes/_protected.settings/-components/settings-card.pending";

/** The sessions card (`SessionsCard`): its header over the caller's panel. */
export const SessionsCardFrame = ({ children }: { children: ReactNode }) => (
  <SettingsCardPending title="common.sessions">{children}</SettingsCardPending>
);

/** Placeholder sessions while the list loads. */
const SESSION_ROWS_PENDING = [
  { key: "a" },
  { key: "b" },
  { key: "c" },
] as const;

/**
 * The card while its sessions load, both as the card's own fallback and in
 * the profile's pending phase: one line per session (device, address, last
 * active, status).
 */
export const SessionsCardPending = () => (
  <SessionsCardFrame>
    <FramePanel aria-hidden="true" className="flex flex-col gap-3 p-4">
      {SESSION_ROWS_PENDING.map((row) => (
        <div className="flex items-center justify-between gap-4" key={row.key}>
          <FaceLabelPending className="w-40" />
          <FaceLabelPending className="w-24" />
          <FaceLabelPending className="w-20" />
          <FaceLabelPending className="w-16" />
        </div>
      ))}
    </FramePanel>
  </SessionsCardFrame>
);
