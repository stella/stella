import { panic } from "better-result";

import type { CorrespondenceFiler } from "@stll/api-contract/correspondence";

import {
  hasAlignedAuthentication,
  type MailAuthentication,
} from "@/api/lib/inbound-mail/authentication";

export type InboundFiler = {
  user: Pick<
    Extract<CorrespondenceFiler, { type: "user" }>,
    "type" | "userId" | "filedAt"
  >;
  shared_mailbox: Pick<
    Extract<CorrespondenceFiler, { type: "shared_mailbox" }>,
    "type" | "allowedSenderId" | "address" | "approvedBy" | "filedAt"
  >;
}[CorrespondenceFiler["type"]];

export type SenderMembership =
  | { status: "denied" }
  | {
      status: "allowed";
      filer: InboundFiler;
    };

export type InboundAcceptance =
  | { status: "accept"; filer: InboundFiler }
  | {
      status: "drop";
      reason:
        | "missing-sender"
        | "sender-not-authorized"
        | "authentication-failed"
        | "malware-detected"
        | "scan-unavailable";
    };

export type AttachmentScanVerdict = "pass" | "fail" | "unavailable";

type EvaluateInboundAcceptanceOptions = {
  outerSender: string | null;
  authentication: MailAuthentication;
  membership: SenderMembership;
  scan: AttachmentScanVerdict;
};

export const evaluateInboundAcceptance = ({
  outerSender,
  authentication,
  membership,
  scan,
}: EvaluateInboundAcceptanceOptions): InboundAcceptance => {
  if (!outerSender) {
    return { status: "drop", reason: "missing-sender" };
  }
  if (!hasAlignedAuthentication(authentication, outerSender)) {
    return { status: "drop", reason: "authentication-failed" };
  }
  if (membership.status === "denied") {
    return { status: "drop", reason: "sender-not-authorized" };
  }
  switch (scan) {
    case "fail":
      return { status: "drop", reason: "malware-detected" };
    case "unavailable":
      return { status: "drop", reason: "scan-unavailable" };
    case "pass":
      return { status: "accept", filer: membership.filer };
    default: {
      scan satisfies never;
      return panic("Unhandled inbound scan verdict");
    }
  }
};
