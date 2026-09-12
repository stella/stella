/**
 * Verification codes leave the product printed inside documents: the DOCX
 * footer carries `stl:<code>`, and whoever holds the file retypes it to
 * resolve the version. The alphabet and the length are therefore frozen for
 * the life of the product - changing either retires every reference already
 * printed, since those files cannot be reissued. The only permitted evolution
 * is accepting a further format alongside this one, never altering this one.
 *
 * Lowercase alphanumeric minus the look-alikes 0/O/1/l/I, so a code read off
 * paper has one spelling; 31 symbols over 10 places is 31^10 ~ 8.2e14 codes.
 */
export const VERIFICATION_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export const VERIFICATION_CODE_LENGTH = 10;

/**
 * Regex source rather than a `RegExp`, because Elysia's `t.String({ pattern })`
 * takes the source string and `new RegExp` takes it too, so the route guard and
 * every client check read one value. Interpolating the alphabet is sound only
 * because it holds no character that is special inside a class, which the
 * frozen contract above guarantees.
 */
export const VERIFICATION_CODE_PATTERN = `^[${VERIFICATION_CODE_ALPHABET}]{${VERIFICATION_CODE_LENGTH}}$`;

const VERIFICATION_CODE_RE = new RegExp(VERIFICATION_CODE_PATTERN, "u");

/**
 * A printed code is retyped by hand, so its shape is checked before it is
 * looked up: a segment that cannot be a code gets the same answer as one that
 * resolves to nothing.
 */
export const isVerificationCode = (value: string): boolean =>
  VERIFICATION_CODE_RE.test(value);

/** The document version resolved from a frozen verification code. */
export type DocumentReferenceMatch = {
  entityId: string;
  entityName: string | null;
  workspaceId: string;
  workspaceName: string;
  /** The reference frozen onto the matched version. */
  stamp: string;
  /** The version the reference points at: what the holder of the file has. */
  versionNumber: number;
  /** Highest non-deleted version number the document currently has. */
  currentVersionNumber: number;
  /**
   * The reference frozen onto the document's current version, or null when
   * that version carries none. It differs from {@link stamp} once the document
   * has been refiled.
   */
  currentStamp: string | null;
};

/** A reference such as `2026/001/015.v3` with its version suffix removed. */
const STAMP_VERSION_SUFFIX_RE = /\.v\d+$/u;

/** The document-identifying part of a stamp, without the version it names. */
export const documentReferenceBase = (stamp: string): string =>
  stamp.replace(STAMP_VERSION_SUFFIX_RE, "");

/**
 * The stamp the document carries now, when that is no longer the one printed
 * on the file in hand; null while the two agree.
 *
 * Moving a document to another matter, or editing a matter's reference, leaves
 * every stamp already frozen onto a version untouched and files the next one
 * under the new reference. A higher version suffix is ordinary supersession
 * and is reported as such, so only the reference itself is compared here.
 */
export const refiledStamp = ({
  stamp,
  currentStamp,
}: Pick<DocumentReferenceMatch, "stamp" | "currentStamp">): string | null =>
  currentStamp !== null &&
  documentReferenceBase(currentStamp) !== documentReferenceBase(stamp)
    ? currentStamp
    : null;

/**
 * A matter reference that documents were once numbered under belongs to that
 * matter for good: printed stamps keep naming it, so no other matter may take
 * it over. The matter update returns this code with status 409 when a request
 * tries; a live matter already holding the reference is a plain 409.
 */
export const MATTER_REFERENCE_RETIRED_CODE = "matter_reference_retired";

/**
 * The same grammar {@link documentReferenceBase} strips from, read forwards:
 * one whitespace-free token whose last segment is the zero-padded document
 * sequence, optionally followed by the version suffix. The matter reference
 * in front of it is free-form and may itself contain slashes (`AB/12/001`).
 *
 * The padding is three places, so a matter past its 999th document produces a
 * longer sequence that reads as an ordinary query rather than a reference.
 * That costs precision, never recall: such a query keeps the fuzzy fallbacks.
 */
const DOCUMENT_REFERENCE_QUERY_RE = /^\S+\/\d{3}(?:\.v\d+)?$/u;

/**
 * Whether a search string is a whole document reference. A reference names
 * one document, so a query shaped like one is answered exactly; anything else
 * stays a text search, where widening recall is the right trade.
 */
export const isDocumentReferenceQuery = (query: string): boolean =>
  DOCUMENT_REFERENCE_QUERY_RE.test(query);
