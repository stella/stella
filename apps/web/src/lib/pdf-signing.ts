import { Temporal } from "@stll/time";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import type { PdfSigningStamp } from "@/lib/pdf-signing-stamp.logic";
import {
  decidePdfSigningPoll,
  parsePdfSigningDeadline,
  type PdfSigningOutcome,
  type PdfSigningSessionSnapshot,
} from "@/lib/pdf-signing.logic";
import { toSafeId } from "@/lib/safe-id";

export type PdfSigningTarget = {
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
}: PdfSigningTarget & { stamp?: PdfSigningStamp | undefined }) => {
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

const nowMs = () => Temporal.Now.instant().epochMilliseconds;

const wait = async (milliseconds: number) => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

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
  let deadline = parsePdfSigningDeadline({ expiresAt, now: nowMs() });

  for (;;) {
    const session = await readPdfSigningSession({ sessionId, workspaceId });
    const decision = decidePdfSigningPoll({
      deadline,
      now: nowMs(),
      session,
    });

    if (decision.type === "settled") {
      return decision.outcome;
    }

    deadline = decision.deadline;
    await wait(decision.delayMs);
  }
};
