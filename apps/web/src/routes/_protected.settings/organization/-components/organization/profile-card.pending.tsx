import type { ReactNode } from "react";

import {
  ButtonFace,
  FaceLabelPending,
  FieldFace,
  InputFace,
  LabelFace,
} from "@stll/ui/control-face";
import { SettingsPanel, SettingsSection } from "@stll/ui/settings";
import { Skeleton } from "@stll/ui/skeleton";

import { PendingText } from "@/components/pending-text";
import { FORM_STACK_CLASS } from "@/routes/_protected.settings/-components/settings-section.pending";

/*
 * The organization's profile card (`./profile-card.tsx`): its logo row (the
 * logo, then its actions) over the name field and the save button. The card
 * renders `OrganizationProfileCardFrame` and `OrganizationProfileLogoRow`;
 * the General page's pending phase renders `OrganizationProfileCardPending`,
 * the same boxes with the controls' faces.
 */

/** The card's section around its form. */
export const OrganizationProfileCardFrame = ({
  children,
}: {
  children: ReactNode;
}) => (
  <SettingsSection>
    <SettingsPanel>{children}</SettingsPanel>
  </SettingsSection>
);

/** The logo and its actions, on one row. */
export const OrganizationProfileLogoRow = ({
  children,
}: {
  children: ReactNode;
}) => <div className="flex items-center gap-3">{children}</div>;

/** The logo's size (`UserIdentityAvatar`'s box). */
export const ORGANIZATION_LOGO_CLASS = "size-12 text-sm";

/**
 * The card before the organization is read: the logo's circle, the upload
 * action (every member who reaches the page may change the profile), the
 * name field and the save button, unavailable. The remove action, shown only
 * beside a logo, joins on the logo's row once the page knows there is one.
 */
export const OrganizationProfileCardPending = () => (
  <OrganizationProfileCardFrame>
    {/* The live `Form`'s column. */}
    <div className={FORM_STACK_CLASS}>
      <OrganizationProfileLogoRow>
        <Skeleton className="size-12 shrink-0 rounded-full" />
        <ButtonFace size="sm" variant="outline">
          <PendingText
            barClassName="w-20"
            id="settings.organization.uploadLogo"
          />
        </ButtonFace>
      </OrganizationProfileLogoRow>
      <FieldFace>
        <LabelFace>
          <PendingText barClassName="w-32" id="common.organizationName" />
        </LabelFace>
        <InputFace>
          <FaceLabelPending className="w-40" />
        </InputFace>
      </FieldFace>
      <ButtonFace className="self-start" size="default" variant="default">
        <PendingText barClassName="w-24" id="common.saveChanges" />
      </ButtonFace>
    </div>
  </OrganizationProfileCardFrame>
);
