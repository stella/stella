import { Result } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import type { PreparedReaderAnswer } from "@/api/handlers/legal-reader/answers/operation";
import { streamReaderAnswer } from "@/api/handlers/legal-reader/answers/stream";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { OrgAIConfigStatus } from "@/api/lib/ai-config-loader-core";
import type { SafeId } from "@/api/lib/branded-types";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import type { AnnotationAuthorScope } from "@/api/lib/legal-search/reader-annotations/target";
import { createModelActionAdmitter } from "@/api/lib/rate-limit/model-action-admission";
import { requireTanStackAIAvailableForTask } from "@/api/lib/tanstack-ai-models";
import type { UsageLaneDecision } from "@/api/lib/usage/lane-routing";

type ReaderAnswerRequestOptions = Pick<
  AnnotationAuthorScope,
  "safeDb" | "recordAuditEvent"
> & {
  session: { activeOrganizationId: SafeId<"organization"> };
  user: { id: SafeId<"user">; readerAnswerLanguage?: string | null };
  scopedDb: ScopedDb;
  orgAIConfig: OrgAIConfig | null;
  orgAIConfigStatus: OrgAIConfigStatus;
  managedAIResidency: ManagedAIResidency;
  request: Request;
  usageLane?: UsageLaneDecision;
};

/** All generation routes share provider policy and the existing chat admission lane. */
export const readerAnswerRequest = ({
  session,
  user,
  safeDb,
  recordAuditEvent,
  scopedDb,
  orgAIConfig,
  orgAIConfigStatus,
  managedAIResidency,
  request,
  usageLane,
}: ReaderAnswerRequestOptions) => {
  const available = requireTanStackAIAvailableForTask({
    task: "chat",
    orgConfig: orgAIConfig,
    configStatus: orgAIConfigStatus,
    dataClass: "customer",
  });
  if (available.isErr()) {
    return available;
  }
  const scope = {
    organizationId: session.activeOrganizationId,
    userId: user.id,
    safeDb,
    recordAuditEvent,
  };
  return Result.ok({
    scope,
    stream: (prepared: PreparedReaderAnswer) =>
      streamReaderAnswer({
        ...scope,
        prepared: {
          ...prepared,
          locale:
            prepared.locale ??
            (user.readerAnswerLanguage === "document"
              ? undefined
              : (user.readerAnswerLanguage ?? undefined)),
        },
        orgAIConfig,
        managedAIResidency,
        requestSignal: request.signal,
        ...(usageLane === undefined ? {} : { usageLane }),
        admitModelAction: createModelActionAdmitter({
          organizationId: scope.organizationId,
          userId: scope.userId,
          organizationStateDb: scopedDb,
          actionKind: "chat.send",
          scope: "independent",
        }),
      }),
  });
};
