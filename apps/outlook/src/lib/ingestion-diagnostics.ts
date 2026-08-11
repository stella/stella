import { Result } from "better-result";

import {
  OUTLOOK_HOST_VERSION_PATTERN,
  OUTLOOK_MAILBOX_REQUIREMENT_SET,
  type OutlookIngestionDiagnostic,
  type OutlookIngestionOutcome,
  type OutlookIngestionRetryStage,
} from "@stll/api-contract";

import { getOfficeRuntime } from "@/lib/office";
import type { OutlookAttachment } from "@/types";

type DiagnosticBase = Omit<
  OutlookIngestionDiagnostic,
  "outcome" | "retryStage"
>;

const normalizeHost = (value: unknown): "Outlook" | null =>
  value === "Outlook" ? value : null;

const normalizePlatform = (
  value: unknown,
): DiagnosticBase["platform"] => {
  switch (value) {
    case "Android":
    case "iOS":
    case "Mac":
    case "OfficeOnline":
    case "PC":
    case "Universal":
      return value;
    default:
      return null;
  }
};

const normalizeHostVersion = (value: unknown): string | null =>
  typeof value === "string" && OUTLOOK_HOST_VERSION_PATTERN.test(value)
    ? value
    : null;

const readRuntimeDiagnostics = (): Pick<
  DiagnosticBase,
  "host" | "hostVersion" | "mailboxRequirementSetSupported" | "platform"
> => {
  const office = getOfficeRuntime();
  if (!office) {
    return {
      host: null,
      hostVersion: null,
      mailboxRequirementSetSupported: null,
      platform: null,
    };
  }
  const diagnostics = office.context.diagnostics;
  const requirements = office.context.requirements;
  const requirementSupport = Result.try({
    try: () =>
      requirements.isSetSupported(
        OUTLOOK_MAILBOX_REQUIREMENT_SET.name,
        OUTLOOK_MAILBOX_REQUIREMENT_SET.version,
      ),
    catch: (cause) => cause,
  });
  const mailboxRequirementSetSupported = Result.isError(requirementSupport)
    ? null
    : requirementSupport.value;

  return {
    host: normalizeHost(diagnostics.host),
    hostVersion: normalizeHostVersion(diagnostics.version),
    mailboxRequirementSetSupported,
    platform: normalizePlatform(diagnostics.platform),
  };
};

export const createIngestionDiagnosticBase = (
  attachments: readonly OutlookAttachment[],
): DiagnosticBase => ({
  aggregateAttachmentBytes: attachments.every(
    (attachment) => attachment.size !== null,
  )
    ? attachments.reduce((total, attachment) => total + (attachment.size ?? 0), 0)
    : null,
  attachmentCount: attachments.length,
  ...readRuntimeDiagnostics(),
  traceId: crypto.randomUUID(),
});

export const ingestionDiagnostic = (
  base: DiagnosticBase,
  retryStage: OutlookIngestionRetryStage,
  outcome: OutlookIngestionOutcome,
): OutlookIngestionDiagnostic => ({ ...base, outcome, retryStage });

export const diagnosticBase = (
  diagnostic: OutlookIngestionDiagnostic,
): DiagnosticBase => ({
  aggregateAttachmentBytes: diagnostic.aggregateAttachmentBytes,
  attachmentCount: diagnostic.attachmentCount,
  host: diagnostic.host,
  hostVersion: diagnostic.hostVersion,
  mailboxRequirementSetSupported:
    diagnostic.mailboxRequirementSetSupported,
  platform: diagnostic.platform,
  traceId: diagnostic.traceId,
});
