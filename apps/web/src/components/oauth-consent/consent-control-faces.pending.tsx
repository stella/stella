import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import {
  DetailsListFace,
  DetailsListItemFace,
} from "@stll/ui/details-list-face";

import { PendingText } from "@/components/pending-text";

export const OAuthAccountList = ({ children }: { children: ReactNode }) => (
  <DetailsListFace>{children}</DetailsListFace>
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
  <DetailsListItemFace className="items-start sm:items-center" label={label}>
    <div className="flex min-w-0 flex-col items-start gap-x-3">
      {email}
      {switchAccount}
    </div>
  </DetailsListItemFace>
);

export const ConsentOrganizationValue = ({
  children,
}: {
  children: ReactNode;
}) => <p className="flex min-h-11 items-center">{children}</p>;

export const ConsentOrganizationPending = () => (
  <DetailsListItemFace
    label={<PendingText id="common.organization" barClassName="w-20" />}
  >
    <ConsentOrganizationValue>
      <FaceLabelPending className="w-28" />
    </ConsentOrganizationValue>
  </DetailsListItemFace>
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

export const ConsentDecisionBarFace = ({
  error,
  children,
}: {
  error?: ReactNode;
  children: ReactNode;
}) => (
  <div
    className="border-border/64 bg-background flex shrink-0 flex-col gap-2 border-t px-6 py-4"
    data-slot="consent-decision-bar"
  >
    {error}
    <div className="grid grid-cols-2 gap-3 *:min-h-11 *:w-full">{children}</div>
  </div>
);

export const ConsentDecisionBarPending = () => (
  <ConsentDecisionBarFace>
    <ButtonFace size="default" variant="outline">
      <PendingText id="common.decline" barClassName="w-12" />
    </ButtonFace>
    <ButtonFace size="default" variant="default">
      <PendingText id="consent.allow" barClassName="w-10" />
    </ButtonFace>
  </ConsentDecisionBarFace>
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
