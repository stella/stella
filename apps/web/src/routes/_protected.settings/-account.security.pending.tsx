import type { ReactNode } from "react";

import { ListItemSkeleton } from "@stll/ui/list-shell";
import { Skeleton } from "@stll/ui/skeleton";

import { framePendingView } from "@/routes/-pending-view.logic";
import { PersonalDataExportCardPending } from "@/routes/_protected.settings/-components/account/personal-data-export-card.pending";
import { SignInMethodsPending } from "@/routes/_protected.settings/-components/account/sign-in-methods.pending";
import { TwoFactorCardPending } from "@/routes/_protected.settings/-components/account/two-factor-card.pending";
import { SettingsPageHeaderPending } from "@/routes/_protected.settings/-components/settings-page-header.pending";
import { SettingsSectionPending } from "@/routes/_protected.settings/-components/settings-section.pending";
import { SettingsPagePending } from "@/routes/_protected.settings/-components/settings-shell/settings-shell.pending";

/*
 * The security page's one layout, drawn by both phases: the heading, the
 * summary tiles, the review of a sign-in the new-device email linked to,
 * the signed-in devices, the sign-in methods, two-factor sign-in and the
 * data export. The page fills the slots with live sections; the pending
 * phase with their faces, so each section lands in its own box.
 */

/** The summary's grid, in both phases. */
export const SECURITY_SUMMARY_CLASS =
  "grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-3";

/** A summary tile's box, in both phases. */
export const SECURITY_SUMMARY_TILE_CLASS =
  "flex flex-col gap-2.5 rounded-2xl border p-4";

/** The devices section's anchor; the summary tile scrolls to it. */
export const SIGNED_IN_DEVICES_SECTION_ID = "signed-in-devices";

type SecurityPageShellProps = {
  summary: ReactNode;
  /** The review card, live phase only. */
  review?: ReactNode;
  devices: ReactNode;
  signInMethods: ReactNode;
  twoFactor: ReactNode;
  dataExport: ReactNode;
};

/** The security page's layout, in both phases. */
export const SecurityPageShell = ({
  summary,
  review,
  devices,
  signInMethods,
  twoFactor,
  dataExport,
}: SecurityPageShellProps) => (
  <>
    <SettingsPageHeaderPending
      description="settings.account.security.description"
      title="settings.account.security.title"
    />
    {review}
    {summary}
    {devices}
    {signInMethods}
    {twoFactor}
    {dataExport}
  </>
);

const SUMMARY_TILES_PENDING = [{ key: "a" }, { key: "b" }, { key: "c" }];
const OTHER_DEVICES_PENDING = [{ key: "a" }, { key: "b" }, { key: "c" }];

export const SecuritySummaryPending = () => (
  <div aria-hidden="true" className={SECURITY_SUMMARY_CLASS}>
    {SUMMARY_TILES_PENDING.map((tile) => (
      <div className={SECURITY_SUMMARY_TILE_CLASS} key={tile.key}>
        <Skeleton className="size-8 rounded-full" />
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-4 w-44 max-w-full" />
      </div>
    ))}
  </div>
);

/** This device and the others, as rows of the devices section. */
export const SignedInDevicesPending = () => (
  <SettingsSectionPending
    description="settings.account.security.devicesDescription"
    title="settings.account.security.devicesTitle"
  >
    {OTHER_DEVICES_PENDING.map((row, index) => (
      <ListItemSkeleton index={index} key={row.key} media />
    ))}
  </SettingsSectionPending>
);

const SecurityPendingView = () => (
  <SettingsPagePending area="account">
    <SecurityPageShell
      dataExport={<PersonalDataExportCardPending />}
      devices={<SignedInDevicesPending />}
      signInMethods={<SignInMethodsPending />}
      summary={<SecuritySummaryPending />}
      twoFactor={<TwoFactorCardPending />}
    />
  </SettingsPagePending>
);

export const SecurityPending = framePendingView(SecurityPendingView);
