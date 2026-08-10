import {
  OFFICE_CITATION_HREF_PREFIX,
  parseOfficeCitationHref,
  type OfficeCitationHrefTarget,
  type OfficeCitationLocator,
} from "@stll/api-contract";

export { OFFICE_CITATION_HREF_PREFIX, parseOfficeCitationHref };

export type OfficeCitationTarget = OfficeCitationHrefTarget;
export type OfficeCitationSource = {
  entityId: string;
  entityName: string | null;
  fieldId: string;
  fileName: string;
  mimeType: string;
  pdfFileId: string | null;
  propertyId: string;
};

export type OfficeCitationNavigation = {
  locator: OfficeCitationLocator;
  target: OfficeCitationTarget;
};

type OfficeCitationRegistration = {
  key: string;
  navigate: (navigation: OfficeCitationNavigation) => void;
};

let registrations: readonly OfficeCitationRegistration[] = [];
let pendingNavigation: OfficeCitationNavigation | null = null;

const citationSourceKey = ({
  entityId,
  fieldId,
}: Pick<OfficeCitationTarget, "entityId" | "fieldId">): string =>
  `${entityId}:${fieldId}`;

export const isVerifiedOfficeCitationTarget = ({
  source,
  target,
}: {
  source: Pick<OfficeCitationSource, "entityId" | "fieldId">;
  target: OfficeCitationTarget;
}): boolean =>
  source.entityId === target.entityId && source.fieldId === target.fieldId;

export const registerOfficeCitationNavigation = ({
  entityId,
  fieldId,
  navigate,
}: {
  entityId: string;
  fieldId: string;
  navigate: (navigation: OfficeCitationNavigation) => void;
}): (() => void) => {
  const key = citationSourceKey({ entityId, fieldId });
  const registration = { key, navigate };
  registrations = [
    ...registrations.filter((candidate) => candidate.key !== key),
    registration,
  ];
  const pending = pendingNavigation;
  if (pending && citationSourceKey(pending.target) === key) {
    pendingNavigation = null;
    queueMicrotask(() => navigate(pending));
  }
  return () => {
    if (
      registrations.find((candidate) => candidate.key === key) === registration
    ) {
      registrations = registrations.filter(
        (candidate) => candidate !== registration,
      );
    }
  };
};

export const requestOfficeCitationNavigation = (
  navigation: OfficeCitationNavigation,
): void => {
  const key = citationSourceKey(navigation.target);
  const registration = registrations.find((candidate) => candidate.key === key);
  if (registration) {
    registration.navigate(navigation);
    return;
  }
  pendingNavigation = navigation;
};
