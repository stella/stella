import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending, InputFace } from "@stll/ui/control-face";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/frame";
import { Label } from "@stll/ui/label";

import { PendingText, useIntlMounted } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

export const AgentClaimShell = ({
  access,
  description,
  form,
  organization,
  title,
}: {
  access: ReactNode;
  description: ReactNode;
  form: ReactNode;
  organization: ReactNode;
  title: ReactNode;
}) => (
  <div className="flex min-h-dvh flex-1 items-center justify-center">
    <Frame className="w-full max-w-sm">
      <FrameHeader>
        <FrameTitle>{title}</FrameTitle>
        <FrameDescription>{description}</FrameDescription>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-4">
        {organization}
        {access}
        {form}
      </FramePanel>
    </Frame>
  </div>
);

export const AgentClaimDetail = ({
  label,
  value,
}: {
  label: ReactNode;
  value: ReactNode;
}) => (
  <div className="flex flex-col gap-1">
    <p className="text-muted-foreground text-sm">{label}</p>
    <p className="text-sm font-medium">{value}</p>
  </div>
);

export const AgentClaimOrganizationPending = () => (
  <AgentClaimDetail
    label={<PendingText barClassName="w-24" id="common.organization" />}
    value={<FaceLabelPending className="w-32" />}
  />
);

export const AGENT_CLAIM_CODE_ID = "agent-claim-code-input";

export const AgentClaimFields = ({
  code,
  label,
  submit,
}: {
  code: ReactNode;
  label: ReactNode;
  submit: ReactNode;
}) => (
  <div className="flex w-full flex-col gap-4">
    <div className="flex flex-col gap-2">
      <Label htmlFor={AGENT_CLAIM_CODE_ID}>{label}</Label>
      {code}
    </div>
    {submit}
  </div>
);

const AgentClaimDescriptionPending = () =>
  useIntlMounted() ? (
    <PendingText id="agentClaim.description" />
  ) : (
    <span aria-hidden="true" className="grid">
      <FaceLabelPending className="w-full" />
      <FaceLabelPending className="w-full" />
      <FaceLabelPending className="w-2/3" />
    </span>
  );

export const AgentClaimPending = framePendingView(() => (
  <AgentClaimShell
    access={
      <AgentClaimDetail
        label={<PendingText barClassName="w-28" id="agentClaim.access" />}
        value={
          <PendingText barClassName="w-36" id="agentClaim.accessReadSearch" />
        }
      />
    }
    description={<AgentClaimDescriptionPending />}
    form={
      <AgentClaimFields
        code={
          <InputFace>
            <PendingText barClassName="w-20" id="agentClaim.codePlaceholder" />
          </InputFace>
        }
        label={
          <PendingText
            barClassName="w-52 max-w-full"
            id="agentClaim.codeLabel"
          />
        }
        submit={
          <ButtonFace className="w-full" size="default" variant="default">
            <PendingText barClassName="w-16" id="agentClaim.approve" />
          </ButtonFace>
        }
      />
    }
    organization={<AgentClaimOrganizationPending />}
    title={<PendingText barClassName="w-36" id="agentClaim.title" />}
  />
));
