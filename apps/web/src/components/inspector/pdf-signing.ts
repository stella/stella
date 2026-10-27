import { sleep } from "@stll/concurrency/sleep";
import { Temporal } from "@stll/time";

import type { PdfSigningStamp } from "@/components/inspector/pdf-signing-stamp.logic";
import {
  decidePdfSigningPoll,
  parsePdfSigningDeadline,
  type PdfSigningOutcome,
  type PdfSigningSessionSnapshot,
  resolveSavedPdfSignTarget,
} from "@/components/inspector/pdf-signing.logic";
import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import type { SafeId } from "@/lib/safe-id";

export type PdfSignableFile = {
  entityId: string;
  fieldId: string;
  propertyId: string;
  workspaceId: string;
};

type ReadSavedPdfSignTargetOptions = {
  entityVersionId: SafeId<"entityVersion">;
  target: PdfSignableFile;
};

/** Resolve the upload receipt's immutable version, even if another save is current. */
export const readSavedPdfSignTarget = async ({
  entityVersionId,
  target,
}: ReadSavedPdfSignTargetOptions) => {
  const version = unwrapApiResponse(
    await api
      .entities({ workspaceId: toSafeId<"workspace">(target.workspaceId) })
      .entity({ entityId: toSafeId<"entity">(target.entityId) })
      .versions({ versionId: entityVersionId })
      .get(),
  );
  return resolveSavedPdfSignTarget({ fields: version.fields, target });
};

type PdfSigningSessionRef = {
  sessionId: string;
  workspaceId: string;
};

/** Omitting `stamp` signs without a visible mark on any page. */
export const createPdfSigningHandoff = async ({
  entityId,
  fieldId,
  propertyId,
  stamp,
  workspaceId,
}: PdfSignableFile & { stamp?: PdfSigningStamp | undefined }) => {
  const response = await api
    .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
    ["pdf-signing-handoffs"].post({
      entityId: toSafeId<"entity">(entityId),
      fieldId: toSafeId<"field">(fieldId),
      propertyId: toSafeId<"property">(propertyId),
      ...(stamp === undefined ? {} : { stamp }),
    });

  return unwrapApiResponse(response);
};

/**
 * Hand the deep link to the OS. There is no loopback bridge for signing: the
 * desktop app is either registered for the scheme or the session simply
 * expires unredeemed.
 */
export const launchPdfSigningDeepLink = (deepLinkUrl: string) => {
  window.location.href = deepLinkUrl;
};

const readPdfSigningSession = async ({
  sessionId,
  workspaceId,
}: PdfSigningSessionRef) => {
  const response = await api
    .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
    ["pdf-signing-sessions"]({
      sessionId: toSafeId<"pdfSigningSession">(sessionId),
    })
    .get();

  return unwrapApiResponse(response) satisfies PdfSigningSessionSnapshot;
};

/**
 * Close an open signing session from the browser. An exchange that already
 * settled is left as it is, so the returned snapshot says which one won.
 */
export const cancelPdfSigningSession = async ({
  sessionId,
  workspaceId,
}: PdfSigningSessionRef) => {
  const sessions = api.entities({
    workspaceId: toSafeId<"workspace">(workspaceId),
  })["pdf-signing-sessions"];
  const response = await sessions({
    sessionId: toSafeId<"pdfSigningSession">(sessionId),
  }).cancel.post();

  return unwrapApiResponse(response) satisfies PdfSigningSessionSnapshot;
};

const nowMs = () => Temporal.Now.instant().epochMilliseconds;

/**
 * Poll one signing session until it settles or its window closes. The desktop
 * app owns the whole exchange from here, so the browser only reads status.
 */
export const watchPdfSigningSession = async ({
  expiresAt,
  sessionId,
  workspaceId,
}: PdfSigningSessionRef & {
  expiresAt: string;
}): Promise<PdfSigningOutcome> => {
  const handoffDeadline = parsePdfSigningDeadline({ expiresAt, now: nowMs() });
  let deadline = handoffDeadline;

  for (;;) {
    const session = await readPdfSigningSession({ sessionId, workspaceId });
    const decision = decidePdfSigningPoll({
      deadline,
      handoffDeadline,
      now: nowMs(),
      session,
    });

    if (decision.type === "settled") {
      return decision.outcome;
    }

    deadline = decision.deadline;
    await sleep(decision.delayMs);
  }
};
