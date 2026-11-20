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

import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

export const AgentClaimShell = ({
  form,
  organization,
}: {
  form: ReactNode;
  organization: ReactNode;
}) => (
  <div className="flex min-h-dvh flex-1 items-center justify-center">
    <Frame className="w-full max-w-sm">
      <FrameHeader>
        <FrameTitle>
          <PendingText barClassName="w-36" id="agentClaim.title" />
        </FrameTitle>
        <FrameDescription>
          <PendingText id="agentClaim.description" />
        </FrameDescription>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-4">
        {organization}
        <AgentClaimDetail
          label={<PendingText barClassName="w-28" id="agentClaim.access" />}
          value={
            <PendingText barClassName="w-36" id="agentClaim.accessReadSearch" />
          }
        />
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
  submit,
}: {
  code: ReactNode;
  submit: ReactNode;
}) => (
  <div className="flex w-full flex-col gap-4">
    <div className="flex flex-col gap-2">
      <Label htmlFor={AGENT_CLAIM_CODE_ID}>
        <PendingText barClassName="w-52 max-w-full" id="agentClaim.codeLabel" />
      </Label>
      {code}
    </div>
    {submit}
  </div>
);

export const AgentClaimPending = framePendingView(() => (
  <AgentClaimShell
    form={
      <AgentClaimFields
        code={
          <InputFace>
            <PendingText barClassName="w-20" id="agentClaim.codePlaceholder" />
          </InputFace>
        }
        submit={
          <ButtonFace className="w-full" size="default" variant="default">
            <PendingText barClassName="w-16" id="agentClaim.approve" />
          </ButtonFace>
        }
      />
    }
    organization={<AgentClaimOrganizationPending />}
  />
));
