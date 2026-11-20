import type { ReactNode } from "react";

import { ButtonFace, InputFace, LabelFace } from "@stll/ui/control-face";

import { PendingText } from "@/components/pending-text";

export const OrganizationStepHeading = ({
  title,
  description,
}: {
  title: ReactNode;
  description: ReactNode;
}) => (
  <>
    <h1 className="text-foreground text-3xl font-light tracking-tight">
      {title}
    </h1>
    <p className="text-muted-foreground mt-2 text-sm">{description}</p>
  </>
);

export const OrganizationStepFooter = ({
  children,
}: {
  children: ReactNode;
}) => (
  <div className="mt-auto flex items-center justify-end pt-8">{children}</div>
);

export const OrganizationStepPending = () => (
  <>
    <OrganizationStepHeading
      title={<PendingText id="onboarding.orgTitle" barClassName="w-48" />}
      description={
        <PendingText id="onboarding.orgSubtitle" barClassName="w-52" />
      }
    />
    <div className="mt-8 flex w-full flex-1 flex-col gap-4">
      <div className="flex flex-col items-start gap-2">
        <LabelFace>
          <PendingText id="onboarding.orgNameLabel" barClassName="w-24" />
        </LabelFace>
        <InputFace>
          <PendingText id="onboarding.orgNamePlaceholder" barClassName="w-32" />
        </InputFace>
      </div>
      <OrganizationStepFooter>
        <ButtonFace size="default" variant="default">
          <PendingText id="onboarding.enterTeamName" barClassName="w-28" />
        </ButtonFace>
      </OrganizationStepFooter>
    </div>
  </>
);
