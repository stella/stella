/** Inspector view kind for one consolidation of a statute, read whole. */
export const STATUTE_VIEW = "statute";

/**
 * What the view needs to address the act and to name its tab. Every field is
 * a plain value, so the payload survives the inspector store's
 * structured-clone boundary and can be validated when it comes back.
 */
export type StatuteViewPayload = {
  /** A block to scroll to and mark once the text is shown. */
  anchorId?: string | undefined;
  /** Jurisdiction, as the act's public address spells it. */
  country: string;
  /** The consolidation on screen: every read in the pane is addressed by it. */
  documentId: string;
  /** The work's own identifier, for the readable half of the id-form address. */
  eli: string | null;
  /** The stored address segment, null where the corpus holds none. */
  slug: string | null;
  statuteTitle: string;
  /** ISO date the consolidation entered into force, or null when unknown. */
  versionValidFrom: string | null;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isOptionalNonEmptyString = (value: unknown): boolean =>
  value === undefined || isNonEmptyString(value);

export const isStatuteViewPayload = (
  value: unknown,
): value is StatuteViewPayload => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return (
    "country" in value &&
    isNonEmptyString(value.country) &&
    "documentId" in value &&
    isNonEmptyString(value.documentId) &&
    "eli" in value &&
    isNullableString(value.eli) &&
    "slug" in value &&
    isNullableString(value.slug) &&
    // The tab is named by it, and a rail holding two unnamed acts tells the
    // reader nothing about either.
    "statuteTitle" in value &&
    isNonEmptyString(value.statuteTitle) &&
    "versionValidFrom" in value &&
    isNullableString(value.versionValidFrom) &&
    (!("anchorId" in value) || isOptionalNonEmptyString(value.anchorId))
  );
};

/**
 * One tab per consolidation: opening the same wording again focuses the tab
 * that is already there, while another consolidation of the act is its own
 * text and so its own tab.
 */
export const statuteTabId = (documentId: string): string =>
  `${STATUTE_VIEW}:${documentId}`;

export type StatuteViewTab = {
  type: typeof STATUTE_VIEW;
  id: string;
  label: string;
  payload: StatuteViewPayload;
};

/**
 * The consolidation to open, as a citation holds it: the same fields
 * `createStatuteLinkTarget` takes, so the link and the tab are built from one
 * reading of the citation.
 */
type CreateStatuteViewTabOptions = {
  anchorId?: string | undefined;
  country: string;
  documentId: string;
  eli?: string | null | undefined;
  slug?: string | null | undefined;
  statuteTitle: string;
  versionValidFrom?: string | null | undefined;
};

/** The `openView` arguments for the act a citation names. */
export const createStatuteViewTab = ({
  anchorId,
  country,
  documentId,
  eli,
  slug,
  statuteTitle,
  versionValidFrom,
}: CreateStatuteViewTabOptions): StatuteViewTab => ({
  type: STATUTE_VIEW,
  id: statuteTabId(documentId),
  label: statuteTitle,
  payload: {
    country,
    documentId,
    eli: eli ?? null,
    slug: slug ?? null,
    statuteTitle,
    versionValidFrom: versionValidFrom ?? null,
    ...(anchorId === undefined ? {} : { anchorId }),
  },
});
