import type { ReactNode } from "react";

import {
  ButtonFace,
  FaceLabelPending,
  FieldTriggerFace,
} from "@stll/ui/control-face";
import { Frame, FramePanel } from "@stll/ui/frame";

import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";
import { PersonalDataExportCardPending } from "@/routes/_protected.settings/-components/account/personal-data-export-card.pending";
import { SessionsCardPending } from "@/routes/_protected.settings/-components/account/sessions-card.pending";
import { SignInMethodsPending } from "@/routes/_protected.settings/-components/account/sign-in-methods.pending";
import { TwoFactorCardPending } from "@/routes/_protected.settings/-components/account/two-factor-card.pending";
import {
  FORM_STACK_CLASS,
  FormFieldSkeleton,
  SettingsCardPending,
  SettingsSwitchCardPending,
} from "@/routes/_protected.settings/-components/settings-card.pending";
import { SettingsPageHeaderPending } from "@/routes/_protected.settings/-components/settings-page-header.pending";
import { SettingsPagePending } from "@/routes/_protected.settings/-components/settings-shell/settings-shell.pending";

/*
 * The profile page's one layout, drawn by both phases: the heading, then
 * the display name, the time zone with the Word edit identity, the locale
 * preferences, the account's cards and the danger zone. The page fills its
 * slots with the live forms and cards; the pending phase with the fields'
 * and cards' faces, so each card that loads lands in its own box.
 */

/** The width of the display name and the preferred name fields. */
export const PROFILE_NAME_FIELD_CLASS = "max-w-lg";

/** The width of the Word edit shortcut field. */
export const PROFILE_SHORTCUT_FIELD_CLASS = "max-w-xs";

/** The width of a locale preference's picker (the page's `w-56` trigger). */
const LOCALE_PREFERENCE_TRIGGER_CLASS = "w-56";

/** The locale preferences the profile sets. */
type LocalePreference =
  "language" | "regionalFormat" | "calendar" | "weekStart" | "numbers";

/** The locale preferences in order, by the caption each row shows. */
export const LOCALE_PREFERENCE_LABELS = {
  language: "common.language",
  regionalFormat: "appearance.regionalFormat",
  calendar: "appearance.calendar",
  weekStart: "appearance.weekStart",
  numbers: "appearance.numbers",
} as const satisfies Record<LocalePreference, PendingTextKey>;

/** One locale preference: its caption at the start, its picker at the end. */
export const PreferenceRow = ({
  children,
  label,
}: {
  /** The caption (a `Label` bound to the picker). */
  label: ReactNode;
  children: ReactNode;
}) => (
  <div className="flex items-center justify-between gap-4 p-3">
    {label}
    {children}
  </div>
);

/**
 * A row caption's box: the page's `Label` (`default` variant with
 * `text-sm font-medium`) as its classes merge.
 */
const PREFERENCE_ROW_CAPTION_CLASS =
  "text-foreground inline-flex items-center gap-2 text-sm font-medium sm:text-sm/4";

type ProfilePageShellProps = {
  /** The display name form. */
  displayName: ReactNode;
  /** The time zone picker. */
  timeZone: ReactNode;
  /** The preferred name and Word edit shortcut form. */
  wordEditIdentity: ReactNode;
  /** The locale preference rows (`PreferenceRow`s). */
  localePreferences: ReactNode;
  /** The account's own cards: notifications, sign-in, two-factor, sessions,
   *  data export. */
  accountCards: ReactNode;
  /** The danger zone's action. */
  deleteAccount: ReactNode;
  /** What the page mounts beside its cards (the deletion dialog). */
  children?: ReactNode;
};

/** The profile page's layout, in both phases. */
export const ProfilePageShell = ({
  accountCards,
  children,
  deleteAccount,
  displayName,
  localePreferences,
  timeZone,
  wordEditIdentity,
}: ProfilePageShellProps) => (
  <>
    <SettingsPageHeaderPending
      description="settings.account.profileDescription"
      title="common.profile"
    />
    <SettingsCardPending
      description="settings.account.displayNameDescription"
      title="common.displayName"
    >
      <FramePanel>
        <div className="p-4">{displayName}</div>
      </FramePanel>
    </SettingsCardPending>

    <SettingsCardPending
      description="settings.account.timezoneDescription"
      title="settings.account.timezone"
    >
      <FramePanel>
        <div className="flex flex-col gap-2 p-4">{timeZone}</div>
        <div className="border-border border-t p-4">{wordEditIdentity}</div>
      </FramePanel>
    </SettingsCardPending>

    <Frame>
      <div className="divide-border divide-y">{localePreferences}</div>
    </Frame>

    {accountCards}

    <SettingsCardPending
      description="settings.account.dangerZoneDescription"
      title="settings.account.dangerZone"
      tone="destructive"
    >
      <FramePanel>
        <div className="flex flex-col gap-4 p-4">
          <p className="text-muted-foreground text-sm">
            <PendingText
              barClassName="w-96 max-w-full"
              id="settings.account.deleteAccountWarning"
            />
          </p>
          <div>{deleteAccount}</div>
        </div>
      </FramePanel>
    </SettingsCardPending>
    {children}
  </>
);

/** A form's save button, unavailable until the page is there. */
const SaveButtonPending = () => (
  <ButtonFace className="w-fit" size="default" variant="default">
    <PendingText barClassName="w-10" id="common.save" />
  </ButtonFace>
);

const LOCALE_PREFERENCE_ROWS = Object.values(LOCALE_PREFERENCE_LABELS);

const ProfilePendingView = () => (
  <SettingsPagePending>
    <ProfilePageShell
      accountCards={
        <>
          <SettingsSwitchCardPending
            description="settings.account.chatNotificationsDescription"
            label="settings.account.chatNotificationsToggle"
            title="settings.account.chatNotifications"
          />
          <SettingsSwitchCardPending
            description="settings.account.chatTechnicalDetailsDescription"
            label="settings.account.chatTechnicalDetailsToggle"
            title="settings.account.chatTechnicalDetails"
          />
          <SignInMethodsPending />
          <TwoFactorCardPending />
          <SessionsCardPending />
          <PersonalDataExportCardPending />
        </>
      }
      deleteAccount={
        <ButtonFace size="default" variant="destructive">
          <PendingText
            barClassName="w-28"
            id="settings.account.deleteAccount"
          />
        </ButtonFace>
      }
      displayName={
        <div className={FORM_STACK_CLASS}>
          <FormFieldSkeleton className={PROFILE_NAME_FIELD_CLASS} />
          <SaveButtonPending />
        </div>
      }
      localePreferences={LOCALE_PREFERENCE_ROWS.map((label) => (
        <PreferenceRow
          key={label}
          label={
            <span className={PREFERENCE_ROW_CAPTION_CLASS}>
              <PendingText barClassName="w-28" id={label} />
            </span>
          }
        >
          <FieldTriggerFace className={LOCALE_PREFERENCE_TRIGGER_CLASS}>
            <FaceLabelPending className="w-24" />
          </FieldTriggerFace>
        </PreferenceRow>
      ))}
      timeZone={
        <FieldTriggerFace>
          <FaceLabelPending className="w-48" />
        </FieldTriggerFace>
      }
      wordEditIdentity={
        <div className={FORM_STACK_CLASS}>
          <FormFieldSkeleton
            className={PROFILE_NAME_FIELD_CLASS}
            description="settings.account.preferredNameDescription"
            label="settings.account.preferredName"
          />
          <FormFieldSkeleton
            className={PROFILE_SHORTCUT_FIELD_CLASS}
            description="settings.account.wordEditShortcutDescription"
            label="settings.account.wordEditShortcut"
          />
          <SaveButtonPending />
        </div>
      }
    />
  </SettingsPagePending>
);

export const ProfilePending = framePendingView(ProfilePendingView);
