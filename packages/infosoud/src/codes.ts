import {
  INFO_SOUD_ATTRIBUTE_LABELS,
  INFO_SOUD_ATTRIBUTE_LABEL_OVERRIDES,
  INFO_SOUD_CODE_CATALOG_SOURCE_BUNDLE_URL,
  INFO_SOUD_CODE_CATALOG_SOURCE_PAGE_URL,
  INFO_SOUD_EVENT_DESCRIPTIONS,
  INFO_SOUD_EVENT_DESCRIPTION_OVERRIDES,
  INFO_SOUD_EVENT_LABELS,
  INFO_SOUD_EVENT_LABEL_OVERRIDES,
  INFO_SOUD_EVENT_TOOLTIPS,
  INFO_SOUD_EVENT_TOOLTIP_OVERRIDES,
} from "./code-catalog.generated.js";
import type {
  CaseEvent,
  CaseEventWithDetail,
  EventDetailResult,
  EventTypeMetadata,
  LabeledEventAttribute,
  UnknownInfoSoudCodes,
} from "./types.js";

export {
  INFO_SOUD_ATTRIBUTE_LABELS as EVENT_ATTRIBUTE_LABELS,
  INFO_SOUD_ATTRIBUTE_LABEL_OVERRIDES as EVENT_ATTRIBUTE_LABEL_OVERRIDES,
  INFO_SOUD_CODE_CATALOG_SOURCE_BUNDLE_URL,
  INFO_SOUD_CODE_CATALOG_SOURCE_PAGE_URL,
  INFO_SOUD_EVENT_DESCRIPTIONS as EVENT_DESCRIPTIONS,
  INFO_SOUD_EVENT_DESCRIPTION_OVERRIDES as EVENT_DESCRIPTION_OVERRIDES,
  INFO_SOUD_EVENT_LABELS as EVENT_LABELS,
  INFO_SOUD_EVENT_LABEL_OVERRIDES as EVENT_LABEL_OVERRIDES,
  INFO_SOUD_EVENT_TOOLTIPS as EVENT_TOOLTIPS,
  INFO_SOUD_EVENT_TOOLTIP_OVERRIDES as EVENT_TOOLTIP_OVERRIDES,
};

export type EventAttributeLabelScope =
  keyof typeof INFO_SOUD_ATTRIBUTE_LABEL_OVERRIDES;
export type EventLabelScope = keyof typeof INFO_SOUD_EVENT_LABEL_OVERRIDES;

const KNOWN_EVENT_TYPES = new Set<string>([
  ...Object.keys(INFO_SOUD_EVENT_LABELS),
  ...Object.values(INFO_SOUD_EVENT_LABEL_OVERRIDES).flatMap((value) =>
    Object.keys(value),
  ),
]);

const KNOWN_EVENT_ATTRIBUTE_TYPES = new Set<string>([
  ...Object.keys(INFO_SOUD_ATTRIBUTE_LABELS),
  ...Object.values(INFO_SOUD_ATTRIBUTE_LABEL_OVERRIDES).flatMap((value) =>
    Object.keys(value),
  ),
]);

const getScopedLabel = <TScope extends string>({
  code,
  genericLabels,
  scope,
  scopedLabels,
}: {
  code: string;
  genericLabels: Record<string, string>;
  scope?: TScope | undefined;
  scopedLabels: Record<TScope, Record<string, string>>;
}): string | null => {
  if (scope) {
    const scopedLabel = scopedLabels[scope]?.[code];
    if (scopedLabel?.trim()) {
      return scopedLabel;
    }
  }

  const genericLabel = genericLabels[code];
  return genericLabel?.trim() ? genericLabel : null;
};

export const getEventLabelScopeForOrganizationType = (
  organizationType: string | null | undefined,
): EventLabelScope | undefined => {
  const normalized = organizationType?.trim().toLowerCase();
  if (normalized === "ns") {
    return "ns";
  }

  return undefined;
};

export const getEventAttributeLabelScopeForOrganizationType = (
  organizationType: string | null | undefined,
): EventAttributeLabelScope | undefined => {
  const normalized = organizationType?.trim().toLowerCase();
  if (normalized === "ks") {
    return "ks";
  }

  if (normalized === "ns") {
    return "ns";
  }

  return undefined;
};

export const getEventLabel = (
  eventType: string,
  options: { readonly scope?: EventLabelScope | undefined } = {},
): string | null =>
  getScopedLabel({
    code: eventType,
    genericLabels: INFO_SOUD_EVENT_LABELS,
    scope: options.scope,
    scopedLabels: INFO_SOUD_EVENT_LABEL_OVERRIDES,
  });

export const getEventTooltip = (
  eventType: string,
  options: { readonly scope?: EventLabelScope | undefined } = {},
): string | null =>
  getScopedLabel({
    code: eventType,
    genericLabels: INFO_SOUD_EVENT_TOOLTIPS,
    scope: options.scope,
    scopedLabels: INFO_SOUD_EVENT_TOOLTIP_OVERRIDES,
  });

export const getEventDescription = (
  eventType: string,
  options: { readonly scope?: EventLabelScope | undefined } = {},
): string | null =>
  getScopedLabel({
    code: eventType,
    genericLabels: INFO_SOUD_EVENT_DESCRIPTIONS,
    scope: options.scope,
    scopedLabels: INFO_SOUD_EVENT_DESCRIPTION_OVERRIDES,
  });

export const getEventAttributeLabel = (
  attributeType: string,
  options: {
    readonly scope?: EventAttributeLabelScope | undefined;
  } = {},
): string | null =>
  getScopedLabel({
    code: attributeType,
    genericLabels: INFO_SOUD_ATTRIBUTE_LABELS,
    scope: options.scope,
    scopedLabels: INFO_SOUD_ATTRIBUTE_LABEL_OVERRIDES,
  });

export const isKnownEventType = (eventType: string): boolean =>
  KNOWN_EVENT_TYPES.has(eventType);

export const isKnownEventAttributeType = (attributeType: string): boolean =>
  KNOWN_EVENT_ATTRIBUTE_TYPES.has(attributeType);

export const getEventTypeMetadata = (
  detail: Pick<EventDetailResult, "typOrganizace" | "typUdalosti">,
): EventTypeMetadata => {
  const scope = getEventLabelScopeForOrganizationType(detail.typOrganizace);
  return {
    description: getEventDescription(detail.typUdalosti, { scope }),
    known: isKnownEventType(detail.typUdalosti),
    label: getEventLabel(detail.typUdalosti, { scope }),
    tooltip: getEventTooltip(detail.typUdalosti, { scope }),
  };
};

export const getEventDetailTypeLabel = (
  detail: Pick<EventDetailResult, "typOrganizace" | "typUdalosti">,
): string | null => getEventTypeMetadata(detail).label;

export const getLabeledEventAttributes = (
  detail: Pick<EventDetailResult, "atributy" | "typOrganizace">,
): LabeledEventAttribute[] => {
  const scope = getEventAttributeLabelScopeForOrganizationType(
    detail.typOrganizace,
  );

  return detail.atributy.map(({ hodnota, typ }) => ({
    hodnota,
    known: isKnownEventAttributeType(typ),
    label: getEventAttributeLabel(typ, { scope }),
    typ,
  }));
};

export const collectUnknownEventAttributeTypes = (
  detail: Pick<EventDetailResult, "atributy">,
): string[] =>
  Array.from(
    new Set(
      detail.atributy
        .map(({ typ }) => typ)
        .filter((attributeType) => !isKnownEventAttributeType(attributeType)),
    ),
  ).toSorted();

export const collectUnknownEventTypes = (
  events: readonly Pick<CaseEvent | CaseEventWithDetail, "udalost">[],
): string[] =>
  Array.from(
    new Set(
      events
        .map(({ udalost }) => udalost)
        .filter((eventType) => !isKnownEventType(eventType)),
    ),
  ).toSorted();

export const collectUnknownInfoSoudCodes = ({
  details = [],
  events = [],
}: {
  readonly details?: readonly Pick<EventDetailResult, "atributy">[] | undefined;
  readonly events?:
    | readonly Pick<CaseEvent | CaseEventWithDetail, "udalost">[]
    | undefined;
}): UnknownInfoSoudCodes => ({
  attributeTypes: Array.from(
    new Set(
      details.flatMap((detail) => collectUnknownEventAttributeTypes(detail)),
    ),
  ).toSorted(),
  eventTypes: collectUnknownEventTypes(events),
});
