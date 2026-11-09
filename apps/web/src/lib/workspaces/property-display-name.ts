import { useCallback } from "react";

import { useTranslations } from "use-intl";

import {
  DEFAULT_FILE_PROPERTY_NAME,
  isFileProperty,
} from "@stll/api-contract/property-policy";

type NamedProperty = { content: { type: string }; name: string };

/**
 * What a column is called on screen. A matter's file column is stored with one
 * English name for every member, so while it still reads that name each reader
 * sees it in their language; a name anyone gave it stays as written. For
 * display only: an update must send the stored `name`, or saving a column would
 * write the reader's language into a row other members share.
 */
export const propertyDisplayName = (
  property: NamedProperty,
  documentsLabel: string,
): string =>
  isFileProperty(property.content) &&
  property.name === DEFAULT_FILE_PROPERTY_NAME
    ? documentsLabel
    : property.name;

/** {@link propertyDisplayName} with the reader's label already applied. */
export const usePropertyDisplayName = () => {
  const t = useTranslations();
  const documentsLabel = t("common.documents");
  return useCallback(
    (property: NamedProperty) => propertyDisplayName(property, documentsLabel),
    [documentsLabel],
  );
};
