import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { DetailsGrid, DetailsItem } from "@stll/ui/details-grid";

import { PendingText } from "@/components/pending-text";

export const OAuthAccountList = ({ children }: { children: ReactNode }) => (
  <DetailsGrid variant="list">{children}</DetailsGrid>
);

export const OAuthAccountRowFace = ({
  label,
  email,
  switchAccount,
}: {
  label: ReactNode;
  email: ReactNode;
  switchAccount: ReactNode;
}) => (
  <DetailsItem className="items-start sm:items-center" label={label}>
    <div className="flex min-w-0 flex-col items-start gap-x-3">
      {email}
      {switchAccount}
    </div>
  </DetailsItem>
);

export const ConsentOrganizationRow = ({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) => <DetailsItem label={label}>{children}</DetailsItem>;

export const ConsentOrganizationValue = ({
  children,
}: {
  children: ReactNode;
}) => <p className="flex min-h-11 items-center">{children}</p>;

export const ConsentOrganizationPending = () => (
  <ConsentOrganizationRow
    label={<PendingText id="common.organization" barClassName="w-20" />}
  >
    <ConsentOrganizationValue>
      <FaceLabelPending className="w-28" />
    </ConsentOrganizationValue>
  </ConsentOrganizationRow>
);

export const OAuthAccountRowPending = () => (
  <OAuthAccountRowFace
    label={<PendingText id="settings.account.title" barClassName="w-14" />}
    email={<FaceLabelPending className="w-36" />}
    switchAccount={
      <ButtonFace
        size="xs"
        variant="link"
        className="-ms-2 min-h-11 self-start"
      >
        <PendingText id="consent.useAnotherAccount" barClassName="w-32" />
      </ButtonFace>
    }
  />
);

export const ConsentAccountRowsPending = () => (
  <OAuthAccountList>
    <OAuthAccountRowPending />
    <ConsentOrganizationPending />
  </OAuthAccountList>
);

export const ConsentDecisionBarFace = ({
  error,
  decline,
  allow,
}: {
  error?: ReactNode;
  decline: ReactNode;
  allow: ReactNode;
}) => (
  <div
    className="border-border/64 bg-background flex shrink-0 flex-col gap-2 border-t px-6 py-4"
    data-slot="consent-decision-bar"
  >
    {error}
    <div className="grid grid-cols-2 gap-3">
      {decline}
      {allow}
    </div>
  </div>
);

export const ConsentDecisionBarPending = () => (
  <ConsentDecisionBarFace
    decline={
      <ButtonFace size="default" variant="outline" className="min-h-11 w-full">
        <PendingText id="common.decline" barClassName="w-12" />
      </ButtonFace>
    }
    allow={
      <ButtonFace size="default" variant="default" className="min-h-11 w-full">
        <PendingText id="consent.allow" barClassName="w-10" />
      </ButtonFace>
    }
  />
);

export const ConsentActingAsLine = ({ children }: { children: ReactNode }) => (
  <p className="text-muted-foreground -mt-3 text-sm text-pretty">{children}</p>
);

export const ConsentActingAsPending = () => (
  <ConsentActingAsLine>
    <span className="flex">
      <FaceLabelPending className="w-60" />
    </span>
  </ConsentActingAsLine>
);
