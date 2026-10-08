import { sleep } from "@stll/concurrency/sleep";
import { Temporal } from "@stll/time";

import type { PdfSigningStamp } from "@/components/inspector/pdf-signing-stamp.logic";
import {
  decidePdfSigningPoll,
  parsePdfSigningDeadline,
  type PdfSigningOutcome,
  type PdfSigningSessionSnapshot,
} from "@/components/inspector/pdf-signing.logic";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

export type PdfSignableFile = {
  entityId: string;
  propertyId: string;
  workspaceId: string;
};

type PdfSigningSessionRef = {
  sessionId: string;
  workspaceId: string;
};

/** Omitting `stamp` signs without a visible mark on any page. */
export const createPdfSigningHandoff = async ({
  entityId,
  propertyId,
  stamp,
  workspaceId,
}: PdfSignableFile & { stamp?: PdfSigningStamp | undefined }) => {
  const response = await api
    .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
    ["pdf-signing-handoffs"].post({
      entityId: toSafeId<"entity">(entityId),
      propertyId: toSafeId<"property">(propertyId),
      ...(stamp === undefined ? {} : { stamp }),
    });

  return unwrapEden(response);
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

  return unwrapEden(response) satisfies PdfSigningSessionSnapshot;
};

/**
 * Close an open signing session from the browser. An exchange that already
 * settled is left as it is, so the returned snapshot says which one won.
 */
export const cancelPdfSigningSession = async ({
  sessionId,
  workspaceId,
}: PdfSigningSessionRef) => {
  const response = await api
    .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
    ["pdf-signing-sessions"]({
      sessionId: toSafeId<"pdfSigningSession">(sessionId),
    })
    .cancel.post();

  return unwrapEden(response) satisfies PdfSigningSessionSnapshot;
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
