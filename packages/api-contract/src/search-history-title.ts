import { truncateEntityName } from "./entity-options";
import { SEARCH_HISTORY_TITLE_MAX_LENGTH } from "./limits";

const TITLE_SEPARATOR = " · ";
const TITLE_ELLIPSIS = "…";

export type SearchHistoryTitleParts = {
  identifier: string;
  description: string;
};

/** Reserve the identifier before shortening a document's descriptive label. */
export const buildSearchHistoryTitle = ({
  identifier,
  description,
}: SearchHistoryTitleParts): string => {
  const identity = truncateEntityName(
    identifier.trim(),
    SEARCH_HISTORY_TITLE_MAX_LENGTH,
  );
  const label = description.trim();
  const prefix = identity.length === 0 ? "" : `${identity}${TITLE_SEPARATOR}`;
  if (label.length === 0 || prefix.length >= SEARCH_HISTORY_TITLE_MAX_LENGTH) {
    return identity;
  }
  const remaining = SEARCH_HISTORY_TITLE_MAX_LENGTH - prefix.length;
  if (label.length <= remaining) {
    return `${prefix}${label}`;
  }
  return `${prefix}${truncateEntityName(label, remaining - TITLE_ELLIPSIS.length).trimEnd()}${TITLE_ELLIPSIS}`;
};
