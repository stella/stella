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
};
