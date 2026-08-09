import { useMemo, useSyncExternalStore } from "react";

export const EMAIL_CITATION_HREF_PREFIX = "#email:";
export const EMAIL_CITATION_SCROLL_EVENT = "email:scroll-to-citation";
const EMAIL_CITATION_LOOKUP_EVENT = "email:lookup-citation";
const EMAIL_CITATION_REGISTRATION_EVENT = "email:citation-registration";

const EMAIL_CITATION_HREF_RE =
  /^#email:(?<entityId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(?<fieldId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(?<blockId>header-(?:bcc|cc|date|from|subject|to)|body-[0-9]{4})$/iu;

export type EmailCitationBlock = {
  id: string;
  text: string;
};

export type EmailCitationTarget = {
  blockId: string;
  entityId: string;
  fieldId: string;
};

export type EmailCitationSource = {
  entityId: string;
  entityName: string | null;
  fieldId: string;
  fileName: string;
  mimeType: string;
  pdfFileId: string | null;
  propertyId: string;
};

export const parseEmailCitationHref = (
  href: string,
): EmailCitationTarget | null => {
  const match = EMAIL_CITATION_HREF_RE.exec(href);
  const entityId = match?.groups?.["entityId"];
  const fieldId = match?.groups?.["fieldId"];
  const blockId = match?.groups?.["blockId"];
  return entityId && fieldId && blockId ? { blockId, entityId, fieldId } : null;
};

let pendingCitationTarget: EmailCitationTarget | null = null;

const dispatchEmailCitationScroll = (
  target: EmailCitationTarget,
  eventTarget: EventTarget = window,
): void => {
  eventTarget.dispatchEvent(
    new CustomEvent(EMAIL_CITATION_SCROLL_EVENT, { detail: target }),
  );
};

const emitCitationRegistrationChange = (
  eventTarget: EventTarget = window,
): void => {
  eventTarget.dispatchEvent(new Event(EMAIL_CITATION_REGISTRATION_EVENT));
};

const isEmailCitationTargetDetail = (
  value: unknown,
): value is EmailCitationTarget =>
  typeof value === "object" &&
  value !== null &&
  "blockId" in value &&
  typeof value.blockId === "string" &&
  "entityId" in value &&
  typeof value.entityId === "string" &&
  "fieldId" in value &&
  typeof value.fieldId === "string";

export const registerEmailCitationBlocks = ({
  blockIds,
  entityId,
  eventTarget = window,
  fieldId,
}: {
  blockIds: readonly string[];
  entityId: string;
  eventTarget?: EventTarget;
  fieldId: string;
}): (() => void) => {
  const registeredBlockIds = new Set(blockIds);
  const handleLookup = (event: Event): void => {
    if (!("detail" in event) || !isEmailCitationTargetDetail(event.detail)) {
      return;
    }
    const target = event.detail;
    if (
      target.entityId === entityId &&
      target.fieldId === fieldId &&
      registeredBlockIds.has(target.blockId)
    ) {
      event.preventDefault();
    }
  };
  eventTarget.addEventListener(EMAIL_CITATION_LOOKUP_EVENT, handleLookup);
  emitCitationRegistrationChange(eventTarget);

  const pendingTarget = pendingCitationTarget;
  if (
    pendingTarget?.entityId === entityId &&
    pendingTarget.fieldId === fieldId &&
    registeredBlockIds.has(pendingTarget.blockId)
  ) {
    pendingCitationTarget = null;
    queueMicrotask(() => {
      dispatchEmailCitationScroll(pendingTarget, eventTarget);
    });
  }

  return () => {
    eventTarget.removeEventListener(EMAIL_CITATION_LOOKUP_EVENT, handleLookup);
    emitCitationRegistrationChange(eventTarget);
  };
};

export const isKnownEmailCitationTarget = (
  target: EmailCitationTarget,
  eventTarget: EventTarget = window,
): boolean =>
  !eventTarget.dispatchEvent(
    new CustomEvent(EMAIL_CITATION_LOOKUP_EVENT, {
      cancelable: true,
      detail: target,
    }),
  );

export const isVerifiedEmailCitationTarget = ({
  blockIds,
  source,
  target,
}: {
  blockIds: readonly string[];
  source: Pick<EmailCitationSource, "entityId" | "fieldId">;
  target: EmailCitationTarget;
}): boolean =>
  source.entityId === target.entityId &&
  source.fieldId === target.fieldId &&
  blockIds.includes(target.blockId);

export const requestEmailCitationScroll = (
  target: EmailCitationTarget,
): void => {
  if (isKnownEmailCitationTarget(target)) {
    dispatchEmailCitationScroll(target);
    return;
  }
  pendingCitationTarget = target;
};

const subscribeToEmailCitationRegistrations = (
  listener: () => void,
): (() => void) => {
  window.addEventListener(EMAIL_CITATION_REGISTRATION_EVENT, listener);
  return () => {
    window.removeEventListener(EMAIL_CITATION_REGISTRATION_EVENT, listener);
  };
};

const noEmailCitationCleanup = (): void => undefined;
const subscribeToNoEmailCitations = (): (() => void) => noEmailCitationCleanup;

export const useKnownEmailCitationTarget = (
  href: string,
): EmailCitationTarget | null => {
  const target = useMemo(() => parseEmailCitationHref(href), [href]);
  const known = useSyncExternalStore(
    target
      ? subscribeToEmailCitationRegistrations
      : subscribeToNoEmailCitations,
    () => (target ? isKnownEmailCitationTarget(target) : false),
    () => false,
  );
  return known ? target : null;
};

declare global {
  // eslint-disable-next-line typescript-eslint/consistent-type-definitions -- interface declaration merging is required to augment lib.dom WindowEventMap
  interface WindowEventMap {
    "email:citation-registration": Event;
    "email:lookup-citation": CustomEvent<EmailCitationTarget>;
    "email:scroll-to-citation": CustomEvent<EmailCitationTarget>;
  }
}
