import { useMemo, useSyncExternalStore } from "react";

export const EMAIL_CITATION_HREF_PREFIX = "#email:";
export const EMAIL_CITATION_SCROLL_EVENT = "email:scroll-to-citation";

const EMAIL_CITATION_HREF_RE =
  /^#email:(?<fieldId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(?<blockId>header-(?:bcc|cc|date|from|subject|to)|body-[0-9]{4})$/iu;

export type EmailCitationBlock = {
  id: string;
  text: string;
};

export type EmailCitationTarget = {
  blockId: string;
  fieldId: string;
};

export const parseEmailCitationHref = (
  href: string,
): EmailCitationTarget | null => {
  const match = EMAIL_CITATION_HREF_RE.exec(href);
  const fieldId = match?.groups?.["fieldId"];
  const blockId = match?.groups?.["blockId"];
  return fieldId && blockId ? { blockId, fieldId } : null;
};

const citationRegistrations = new Map<
  string,
  Map<symbol, ReadonlySet<string>>
>();
const citationRegistrationListeners = new Set<() => void>();

const emitCitationRegistrationChange = (): void => {
  for (const listener of citationRegistrationListeners) {
    listener();
  }
};

export const registerEmailCitationBlocks = ({
  blockIds,
  fieldId,
}: {
  blockIds: readonly string[];
  fieldId: string;
}): (() => void) => {
  const registrationId = Symbol(fieldId);
  const registrations =
    citationRegistrations.get(fieldId) ??
    new Map<symbol, ReadonlySet<string>>();
  registrations.set(registrationId, new Set(blockIds));
  citationRegistrations.set(fieldId, registrations);
  emitCitationRegistrationChange();

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
  fieldId,
}: EmailCitationTarget): boolean => {
  const registrations = citationRegistrations.get(fieldId);
  if (!registrations) {
    return false;
  }
  for (const blockIds of registrations.values()) {
    if (blockIds.has(blockId)) {
      return true;
    }
  }
  return false;
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
