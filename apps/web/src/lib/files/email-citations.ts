import { useMemo, useSyncExternalStore } from "react";

export const EMAIL_CITATION_HREF_PREFIX = "#email:";
export const EMAIL_CITATION_SCROLL_EVENT = "email:scroll-to-citation";

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

export const parseEmailCitationHref = (
  href: string,
): EmailCitationTarget | null => {
  const match = EMAIL_CITATION_HREF_RE.exec(href);
  const entityId = match?.groups?.["entityId"];
  const fieldId = match?.groups?.["fieldId"];
  const blockId = match?.groups?.["blockId"];
  return entityId && fieldId && blockId ? { blockId, entityId, fieldId } : null;
};

const citationRegistrations = new Map<
  string,
  Map<symbol, { blockIds: ReadonlySet<string>; entityId: string }>
>();
const citationRegistrationListeners = new Set<() => void>();
let pendingCitationTarget: EmailCitationTarget | null = null;

const dispatchEmailCitationScroll = (target: EmailCitationTarget): void => {
  window.dispatchEvent(
    new CustomEvent(EMAIL_CITATION_SCROLL_EVENT, { detail: target }),
  );
};

const emitCitationRegistrationChange = (): void => {
  for (const listener of citationRegistrationListeners) {
    listener();
  }
};

export const registerEmailCitationBlocks = ({
  blockIds,
  entityId,
  fieldId,
}: {
  blockIds: readonly string[];
  entityId: string;
  fieldId: string;
}): (() => void) => {
  const registrationId = Symbol(fieldId);
  const registrations =
    citationRegistrations.get(fieldId) ??
    new Map<symbol, { blockIds: ReadonlySet<string>; entityId: string }>();
  registrations.set(registrationId, { blockIds: new Set(blockIds), entityId });
  citationRegistrations.set(fieldId, registrations);
  emitCitationRegistrationChange();

  const pendingTarget = pendingCitationTarget;
  if (
    pendingTarget?.entityId === entityId &&
    pendingTarget.fieldId === fieldId &&
    isKnownEmailCitationTarget(pendingTarget)
  ) {
    pendingCitationTarget = null;
    queueMicrotask(() => {
      dispatchEmailCitationScroll(pendingTarget);
    });
  }

  return () => {
    const current = citationRegistrations.get(fieldId);
    current?.delete(registrationId);
    if (current?.size === 0) {
      citationRegistrations.delete(fieldId);
    }
    emitCitationRegistrationChange();
  };
};

export const isKnownEmailCitationTarget = ({
  blockId,
  entityId,
  fieldId,
}: EmailCitationTarget): boolean => {
  const registrations = citationRegistrations.get(fieldId);
  if (!registrations) {
    return false;
  }
  for (const registration of registrations.values()) {
    if (
      registration.entityId === entityId &&
      registration.blockIds.has(blockId)
    ) {
      return true;
    }
  }
  return false;
};

export const isVerifiedEmailCitationTarget = ({
  blockIds,
  sourceFieldIds,
  target,
}: {
  blockIds: readonly string[];
  sourceFieldIds: readonly string[];
  target: EmailCitationTarget;
}): boolean =>
  sourceFieldIds.includes(target.fieldId) && blockIds.includes(target.blockId);

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
  citationRegistrationListeners.add(listener);
  return () => {
    citationRegistrationListeners.delete(listener);
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
    "email:scroll-to-citation": CustomEvent<EmailCitationTarget>;
  }
}
